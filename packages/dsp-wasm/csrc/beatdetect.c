/*
 * beatdetect.c — onset envelope + autocorrelation BPM/phase detection in C → WASM.
 *
 * Replaces the per-sample/per-lag JS loops in analysis/beat-detector.ts (the
 * onset envelope + autocorrelation + phase correlation — JS heavy lifting, even
 * though offline). Runs in the analysis Worker. Compiled -O3 -msimd128; the
 * autocorrelation inner loop is the expensive part and vectorizes well.
 *
 * The JS side still owns orchestration (octave snapping, building the Beats
 * object); this kernel does the number crunching: mono downmix → envelope →
 * best lag + best phase offset.
 */

#include <stdint.h>
#include <math.h>
#include <stdlib.h>

/* Results read back by JS after the call. */
static double g_bpm;
static int g_first_beat_frame;
static double g_confidence;

double beatdetect_bpm(void) { return g_bpm; }
int beatdetect_first_beat_frame(void) { return g_first_beat_frame; }
double beatdetect_confidence(void) { return g_confidence; }

void* bd_malloc(int bytes) { return malloc((size_t)bytes); }
void bd_free(void* p) { free(p); }

/* Normalized autocorrelation of the envelope at a given lag (for octave scoring). */
static double env_autocorr(const float* env, int n, int lag, double norm0) {
  if (lag < 1 || lag >= n) return 0.0;
  double acc = 0.0;
  int lim = n - lag;
  for (int i = 0; i < lim; i++) acc += (double)env[i] * env[i + lag];
  return acc / norm0;
}

/*
 * Detect tempo + phase from planar stereo (or mono with src_r == src_l).
 *
 *   src_l, src_r : planar source channels (length frames)
 *   frames       : source length
 *   sample_rate  : Hz
 *   min_bpm/max_bpm : candidate range
 *   env_rate     : onset envelope frame rate (Hz, e.g. 100)
 *   scratch      : a caller-provided float buffer of length >= frames/hop+1 for
 *                  the envelope (avoids malloc in here; size generously)
 *   scratch_len  : length of scratch
 *
 * Writes g_bpm / g_first_beat_frame / g_confidence.
 */
void beatdetect_run(
    const float* src_l, const float* src_r, int frames, int sample_rate,
    double min_bpm, double max_bpm, double env_rate,
    float* scratch, int scratch_len) {
  int hop = (int)(sample_rate / env_rate);
  if (hop < 1) hop = 1;
  int n = frames / hop;
  if (n > scratch_len) n = scratch_len;
  if (n < 4) {
    g_bpm = 0;
    g_first_beat_frame = 0;
    g_confidence = 0;
    return;
  }

  /* Onset envelope: half-wave-rectified RMS-energy flux. */
  float* env = scratch;
  float prev_energy = 0.0f;
  for (int f = 0; f < n; f++) {
    int start = f * hop;
    int end = start + hop;
    float acc = 0.0f;
    for (int i = start; i < end; i++) {
      float s = 0.5f * (src_l[i] + src_r[i]);
      acc += s * s;
    }
    float energy = sqrtf(acc / (float)hop);
    float flux = energy - prev_energy;
    env[f] = flux > 0.0f ? flux : 0.0f;
    prev_energy = energy;
  }

  /* Zero-mean the envelope. */
  double mean = 0.0;
  for (int i = 0; i < n; i++) mean += env[i];
  mean /= (double)n;
  for (int i = 0; i < n; i++) env[i] = (float)(env[i] - mean);

  /* Autocorrelation over the lag range. */
  double lag_for_max = (60.0 / max_bpm) * env_rate;
  double lag_for_min = (60.0 / min_bpm) * env_rate;
  int min_lag = (int)floor(lag_for_max);
  int max_lag = (int)ceil(lag_for_min);
  if (min_lag < 1) min_lag = 1;
  if (max_lag >= n) max_lag = n - 1;

  double norm0 = 0.0;
  for (int i = 0; i < n; i++) norm0 += (double)env[i] * env[i];
  if (norm0 <= 0.0) norm0 = 1.0;

  int best_lag = min_lag;
  double best_score = -1e30;
  for (int lag = min_lag; lag <= max_lag; lag++) {
    double acc = 0.0;
    int lim = n - lag;
    for (int i = 0; i < lim; i++) {
      acc += (double)env[i] * env[i + lag];
    }
    double score = acc / norm0;
    if (score > best_score) {
      best_score = score;
      best_lag = lag;
    }
  }

  double bpm = (60.0 * env_rate) / (double)best_lag;

  /* Octave correction by AUTOCORRELATION EVIDENCE (not a bias toward a magic BPM).
   * The autocorrelation peak can land on a harmonic (½× / 2× the true tempo). For a
   * candidate lag L, score the actual autocorrelation at L plus reinforcement at its
   * 2nd/3rd multiple (a real beat period correlates with its multiples; a spurious
   * double-time lag does not). Pick the octave (½×, 1×, 2× the detected lag) with the
   * strongest combined evidence, within the BPM range. Fixes 80→160 errors. */
  {
    double oct_factor[3] = {1.0, 2.0, 0.5}; /* same, half-tempo, double-tempo */
    double best_oct_score = -1e30;
    double chosen_bpm = bpm;
    for (int o = 0; o < 3; o++) {
      int L = (int)(best_lag * oct_factor[o] + 0.5);
      double cand_bpm = (60.0 * env_rate) / (double)L;
      if (cand_bpm < min_bpm || cand_bpm > max_bpm || L < 1 || L >= n) continue;
      double ev = env_autocorr(env, n, L, norm0) + 0.5 * env_autocorr(env, n, 2 * L, norm0) +
                  0.25 * env_autocorr(env, n, 3 * L, norm0);
      if (ev > best_oct_score) {
        best_oct_score = ev;
        chosen_bpm = cand_bpm;
      }
    }
    bpm = chosen_bpm;
  }

  /* Phase: slide a pulse train at the detected period, pick the best offset. */
  double lag = (60.0 / bpm) * env_rate;
  int offset_steps = (int)ceil(lag);
  int best_off = 0;
  double best_phase = -1e30;
  for (int off = 0; off < offset_steps; off++) {
    double acc = 0.0;
    for (int beat = 0;; beat++) {
      int pos = (int)(off + beat * lag + 0.5);
      if (pos >= n) break;
      acc += env[pos];
    }
    if (acc > best_phase) {
      best_phase = acc;
      best_off = off;
    }
  }

  g_bpm = floor(bpm * 100.0 + 0.5) / 100.0;
  g_first_beat_frame = best_off * hop;
  g_confidence = best_score < 0.0 ? 0.0 : (best_score > 1.0 ? 1.0 : best_score);
}
