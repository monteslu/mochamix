/*
 * peaks.c — waveform band-peak analysis in C → WASM, a faithful port of Mixxx's
 * AnalyzerWaveform (src/analyzer/analyzerwaveform.cpp). Replaces the pure-JS
 * computeBandPeaks (no JS fallback — WASM only, per the "zero heavy JS" rule).
 *
 * Mixxx splits the mono mix into 3 bands with Bessel-4 IIR filters (FIDLIB
 * coefficients, "LpBe4"/"BpBe4"/"HpBe4") at 600 Hz and 4000 Hz crossovers, then
 * stores the per-stride max-abs of the overall signal + each band. We compute the
 * DETAIL and OVERVIEW reductions in a SINGLE pass over the audio (the JS did two).
 *
 * Coefficients + the IIR processSample difference equations are ported verbatim
 * from Mixxx EngineFilterIIR<4,LP> / <8,BP> / <4,HP>. Compiled -O3 -msimd128.
 */

#include <stdint.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h> /* fidlib.h references FILE */
#include "fidlib/fidlib.h"

/* Mixxx crossovers (analyzerwaveform.cpp kLowMidFreqHz / kMidHighFreqHz). */
#define LOW_MID_HZ 600.0
#define MID_HIGH_HZ 4000.0

/* Mixxx's per-band gain lifts so mids/highs read at a comparable level. (Mixxx
 * scales in the renderer; we fold equivalent lifts in here to match our prior
 * look: mid ×2, high ×3, applied before the 0..255 quantize.) */
#define MID_GAIN 2.0
#define HIGH_GAIN 3.0

void* peaks_malloc(int bytes) { return malloc((size_t)bytes); }
void peaks_free(void* p) { free(p); }

/* One Bessel-4 band: coef[0..SIZE] from FIDLIB, buf[SIZE] running state. */
typedef struct {
    double coef[9]; /* max SIZE=8 (band) + 1 */
    double buf[8];
} Band;

/* EngineFilterIIR<4, IIR_LP>::processSample (Mixxx, verbatim). */
static inline double iir4_lp(double* coef, double* buf, double val) {
    double tmp, fir, iir;
    tmp = buf[0]; buf[0] = buf[1]; buf[1] = buf[2]; buf[2] = buf[3];
    iir = val * coef[0];
    iir -= coef[1] * tmp; fir = tmp;
    iir -= coef[2] * buf[0]; fir += buf[0] + buf[0];
    fir += iir;
    tmp = buf[1]; buf[1] = iir; val = fir;
    iir = val;
    iir -= coef[3] * tmp; fir = tmp;
    iir -= coef[4] * buf[2]; fir += buf[2] + buf[2];
    fir += iir;
    buf[3] = iir; val = fir;
    return val;
}

/* EngineFilterIIR<4, IIR_HP>::processSample (Mixxx, verbatim). */
static inline double iir4_hp(double* coef, double* buf, double val) {
    double tmp, fir, iir;
    tmp = buf[0]; buf[0] = buf[1]; buf[1] = buf[2]; buf[2] = buf[3];
    iir = val * coef[0];
    iir -= coef[1] * tmp; fir = tmp;
    iir -= coef[2] * buf[0]; fir += -buf[0] - buf[0];
    fir += iir;
    tmp = buf[1]; buf[1] = iir; val = fir;
    iir = val;
    iir -= coef[3] * tmp; fir = tmp;
    iir -= coef[4] * buf[2]; fir += -buf[2] - buf[2];
    fir += iir;
    buf[3] = iir; val = fir;
    return val;
}

/* EngineFilterIIR<8, IIR_BP>::processSample (Mixxx, verbatim). */
static inline double iir8_bp(double* coef, double* buf, double val) {
    double tmp, fir, iir;
    tmp = buf[0]; buf[0] = buf[1]; buf[1] = buf[2]; buf[2] = buf[3];
    buf[3] = buf[4]; buf[4] = buf[5]; buf[5] = buf[6]; buf[6] = buf[7];
    iir = val * coef[0];
    iir -= coef[1] * tmp; fir = tmp;
    iir -= coef[2] * buf[0]; fir += -buf[0] - buf[0];
    fir += iir;
    tmp = buf[1]; buf[1] = iir; val = fir;
    iir = val;
    iir -= coef[3] * tmp; fir = tmp;
    iir -= coef[4] * buf[2]; fir += -buf[2] - buf[2];
    fir += iir;
    tmp = buf[3]; buf[3] = iir; val = fir;
    iir = val;
    iir -= coef[5] * tmp; fir = tmp;
    iir -= coef[6] * buf[4]; fir += buf[4] + buf[4];
    fir += iir;
    tmp = buf[5]; buf[5] = iir; val = fir;
    iir = val;
    iir -= coef[7] * tmp; fir = tmp;
    iir -= coef[8] * buf[6]; fir += buf[6] + buf[6];
    fir += iir;
    buf[7] = iir; val = fir;
    return val;
}

static inline double absd(double x) { return x < 0 ? -x : x; }
static inline uint8_t q255(double v) {
    double r = v * 255.0;
    if (r > 255.0) r = 255.0;
    if (r < 0.0) r = 0.0;
    return (uint8_t)(r + 0.5);
}

/*
 * Compute band peaks at two resolutions in ONE pass.
 *
 *   src_l, src_r : planar channels (length frames). Mono: pass src_r == src_l.
 *   frames       : source length
 *   sample_rate  : Hz
 *   detail_*     : detail-resolution output arrays (length detail_buckets)
 *   ov_*         : overview output arrays (length ov_buckets)
 *   *_all/_low/_mid/_high : uint8 0..255 per bucket
 *
 * The filters/peaks are identical to Mixxx; we just fan the per-sample max into two
 * bucket accumulators (detail + overview) simultaneously.
 */
void peaks_run(
    const float* src_l, const float* src_r, int frames, int sample_rate,
    int detail_buckets,
    uint8_t* d_all, uint8_t* d_low, uint8_t* d_mid, uint8_t* d_high,
    int ov_buckets,
    uint8_t* o_all, uint8_t* o_low, uint8_t* o_mid, uint8_t* o_high) {

    if (frames <= 0) return;
    if (detail_buckets < 1) detail_buckets = 1;
    if (ov_buckets < 1) ov_buckets = 1;
    if (detail_buckets > frames) detail_buckets = frames;
    if (ov_buckets > frames) ov_buckets = frames;

    /* Design the Bessel-4 band filters with FIDLIB — exactly Mixxx's specs. */
    Band lowF, midF, highF;
    memset(&lowF, 0, sizeof(lowF));
    memset(&midF, 0, sizeof(midF));
    memset(&highF, 0, sizeof(highF));
    char spec[40];
    double sr = (double)sample_rate;
    strcpy(spec, "LpBe4"); lowF.coef[0]  = fid_design_coef(lowF.coef + 1, 4, spec, sr, LOW_MID_HZ, 0, 0);
    strcpy(spec, "BpBe4"); midF.coef[0]  = fid_design_coef(midF.coef + 1, 8, spec, sr, LOW_MID_HZ, MID_HIGH_HZ, 0);
    strcpy(spec, "HpBe4"); highF.coef[0] = fid_design_coef(highF.coef + 1, 4, spec, sr, MID_HIGH_HZ, 0, 0);

    const double dfpb = (double)frames / (double)detail_buckets;
    const double ofpb = (double)frames / (double)ov_buckets;
    int db = 0, ob = 0;
    long dEnd = (long)dfpb;
    long oEnd = (long)ofpb;
    double dA = 0, dL = 0, dM = 0, dH = 0;
    double oA = 0, oL = 0, oM = 0, oH = 0;

    for (int i = 0; i < frames; i++) {
        double s = 0.5 * ((double)src_l[i] + (double)src_r[i]); /* mono mix */
        double lo = iir4_lp(lowF.coef, lowF.buf, s);
        double mi = iir8_bp(midF.coef, midF.buf, s) * MID_GAIN;
        double hi = iir4_hp(highF.coef, highF.buf, s) * HIGH_GAIN;
        double aA = absd(s), aL = absd(lo), aM = absd(mi), aH = absd(hi);

        if (aA > dA) dA = aA; if (aL > dL) dL = aL; if (aM > dM) dM = aM; if (aH > dH) dH = aH;
        if (aA > oA) oA = aA; if (aL > oL) oL = aL; if (aM > oM) oM = aM; if (aH > oH) oH = aH;

        if (i >= dEnd && db < detail_buckets) {
            d_all[db] = q255(dA); d_low[db] = q255(dL); d_mid[db] = q255(dM); d_high[db] = q255(dH);
            db++; dEnd = (long)((db + 1) * dfpb); dA = dL = dM = dH = 0;
        }
        if (i >= oEnd && ob < ov_buckets) {
            o_all[ob] = q255(oA); o_low[ob] = q255(oL); o_mid[ob] = q255(oM); o_high[ob] = q255(oH);
            ob++; oEnd = (long)((ob + 1) * ofpb); oA = oL = oM = oH = 0;
        }
    }
    /* flush trailing buckets */
    if (db < detail_buckets) { d_all[db] = q255(dA); d_low[db] = q255(dL); d_mid[db] = q255(dM); d_high[db] = q255(dH); }
    if (ob < ov_buckets) { o_all[ob] = q255(oA); o_low[ob] = q255(oL); o_mid[ob] = q255(oM); o_high[ob] = q255(oH); }
}
