# 02 — Functional / UX Specification (from the 2.6 manual)

Exhaustive, behavior-level detail with exact control names and numeric ranges. This is the spec a
designer/engineer builds the UI and engine behavior from. Source: <https://manual.mixxx.org/2.6/en/>,
cross-checked against `../mixxx-src/src`.

## 1. Overall UI layout

Toggleable sections (top toolbar): **Decks**, **Mixer**, **Waveforms**, **Effects**, **Samplers**,
**Microphones & Aux** (hidden by default), **Preview Deck** (hidden; Ctrl/Cmd+4), **Library**.

**Skins:** LateNight (default), Deere, Tango, Shade. Resizable elements; scale factor for HiDPI.
(The Sync Leader "Crown" button only appears in LateNight and Deere.)

## 2. Decks

Up to **4 decks**. Each deck has 3 size modes: **Full / Compact / Mini**.

### Transport
- **Play/Pause**.
- **Cue** — behavior depends on **cue mode** (6 modes, default *Mixxx*): Mixxx, Mixxx (no blinking),
  Pioneer (CDJ), Denon, Numark, CUP (cue-up/play-from-cue). In Mixxx mode, Cue sets a temp cue and
  previews from it while held, releasing back to it. CUP jumps to cue and plays on release.
- **Reverse**, plus **Censor** (reverses while held, then resumes as if it never reversed).
- **Beatjump** forward/back (configurable beat increment).

### Rate / tempo
- **Pitch/rate slider** — default range **±10%** (range + direction configurable in
  Preferences ▸ Interface).
- **Rate display** (% change), **effective BPM display** (BPM at current rate).
- **Temporary** pitch-bend buttons (active only while held).
- **Permanent** rate buttons: **4%** default step (`rate_perm_up/down`), **1%** small step.
- Right-click + drag on the waveform = temporary speed change for manual beatmatching.

### Playback toggles
- **Keylock** (master tempo) — `[ChannelN],keylock`. Rate changes affect tempo only, pitch held.
- **Quantize** — snaps cues/loops to the nearest beat.
- **Slip mode** — playback continues silently in the background during loops/scratches; on disable,
  jumps to where the track would have been.
- **Repeat**.

### Sync
- **Sync** button — tap to match BPM + phase once; press-and-hold to engage **Sync Lock**.
  Underlying controls: `beatsync` (tempo+phase), `beatsync_tempo`, `beatsync_phase`.

### Waveform display
- Scrolling **summary waveform** with play marker; **overview** (whole track) showing cues, hotcues,
  intro/outro, loops, beats. Parallel (stacked) or separate layout. Mouse-wheel zoom. **Vinyl widget**
  (spinning platter) for scratch interaction.

### Displays
- Title / artist / cover art; time (elapsed / remaining / both); BPM; **key** (left-click − = down a
  semitone, right-click − = down 10 cents, + analogous; a **MATCH** button picks a harmonic key vs
  the other deck).

### Vinyl control mode (hidden by default)
- **Vinyl** (enable timecode), **Pass** (audio passthrough), **Absolute/Relative/Constant** mode,
  **Cue/Hot** (off / seek-to-cue / seek-to-nearest-hotcue).

## 3. Mixer

### Per-channel
- **Gain/trim** knob (level compensation, above the fader).
- **3-band EQ** — Low / Mid / High knobs.
- **EQ kill switches** — one per band, full band removal; configurable **latching** or **momentary**.
- **QuickEffect / filter super-knob** — meta-knob over an assigned effect; default = **Filter**
  (low-pass/high-pass). Has its own enable toggle (latching).
- **Volume fader**.
- **PFL / headphone (cue)** button — routes channel to headphones for pre-listening.
- **Channel orientation** — Left / Center / Right of the crossfader (0/1/2). Center = unaffected by
  crossfader.
- **Per-channel VU meter**.

### EQ engine (Preferences ▸ Equalizers)
- **Bessel4 LV-Mix** (−24 dB/Oct, linear phase, bit-perfect, low CPU)
- **Bessel8 LV-Mix** (−48 dB/Oct, linear phase, bit-perfect, medium CPU)
- **Linkwitz-Riley** (−48 dB/Oct, minimum phase, high CPU)
- Default high/low-shelf crossovers: Low ≤ **246 Hz**, Mid ≤ **2.5 kHz**, High > 2.5 kHz.
- Option: "Only allow EQ knobs to control EQ-specific effects" (uncheck to use any effect as the EQ).
- A separate **Main/Master EQ** can be configured for the main output.

### Master section
- **Crossfader** (range −1.0…1.0).
- **Main (master) gain**, **Booth gain**, **Head (headphone) gain** — each 0.0…1.0…5.0 (1.0 = unity).
- **Headphone Mix** knob (crossfade headphones between Main and PFL/Cue).
- **Headphone Split Cue** (mono split: right ear = Main, left ear = Cue).
- **Balance** knob (L/R balance of main output).
- **Master stereo VU meters**.

### Crossfader curve (Preferences ▸ Crossfader)
- Curve slider from smooth **mixing** (constant-power) to steep **scratching** (fast cut/full kill).
- **Hamster mode** (reverses the crossfader direction).

### Microphones & Aux (hidden by default)
- **Talk** button (hold or latch), **mic orientation** (L/C/R), **mic gain** + meter. Aux line-ins
  similar.

## 4. Beatmatching & Sync

### Manual beatmatching
Match (a) tempo (rate sliders) and (b) phase (right-click+drag a waveform, or temp pitch-bend
buttons). Listen for the "double bass kick" = drift; re-nudge. A perfect match is impossible
(continuous monitoring needed).

### Sync button
- **Tap:** match tempo + align beats once (needs accurate BPM + beatgrid).
- **Hold:** engage **Sync Lock** (stays lit).

### Sync Lock
Hands beatmatching to Mixxx. Changing rate on any synced deck changes all synced decks
proportionally; any deck can be leader/follower; play/stop/eject/load freely without disrupting
synced decks; automatically handles double/half BPM (140 vs 70 align correctly).

### Sync Leader / dynamic tempo (variable-BPM tracks)
- **Sync Leader (Crown) button** (LateNight + Deere): **Follower** (follows leader unconditionally)
  vs **Soft Leader** (not sticky; passes leadership if the leader stops/goes silent). Default: first
  synced track becomes Soft Leader. Only a playing deck can be leader. Followers may pitch-shift when
  matching tempo (engage keylock to mitigate).
- Pref: "Use steady Tempo for Sync mode" reverts to pre-2.4 behavior.

### Quantize
With quantize on, beats line up exactly (actions snap to the beatgrid), not just tempo.

## 5. Looping

- **Beatloop** sizes (from `beatloop_X`): 1/32, 1/16, 1/8, 1/4, 1/2, 1, 2, 4, 8, 16, 32, 64, 128,
  256, 512 beats.
- **Manual loop-in / loop-out** markers.
- **Loop Halve / Double** buttons.
- **Loop Roll** — temporary rolling loop; on release playback resumes where it would have been (slip).
- **Reloop** — re-enable / jump back into the last loop.
- **Loop move / shift** via beatjump.

## 6. Hotcues

- **Up to 36 hotcues per deck** (control range 1–37; a subset shown by default per skin). Right-click
  for custom **label** + **color**.
- **Main cue point** — single primary cue (behavior per cue mode).
- **Intro / Outro markers** (4-point structure for mix in/out, drives Auto DJ):
  - Intro start — auto-placed at first sound (signal > −60 dBFS).
  - Intro end — manual.
  - Outro start — manual.
  - Outro end — auto-placed at last sound (< −60 dBFS).

## 7. Tempo & Keylock

- Rate slider default **±10%**; range/direction configurable (Preferences ▸ Interface).
- **Keylock toggle** per deck makes rate affect tempo only.
- **Keylock/pitch-bend engine** (Preferences ▸ Sound Hardware): **Rubber Band (faster)**, **Rubber
  Band (finer)** (the R3 high-quality engine), **Soundtouch (faster)** (recommended on low-power
  machines / if buffer underruns occur). Default = Rubber Band.
- **Beat detection** options: "Assume constant tempo" (fixed beatgrid), "Enable Fast Analysis" (first
  minute only), "Enable Offset Correction", "Re-analyze beats when settings change".

## 8. Library

### Track table columns
Played, Artist, Title, Album, Album Artist, Genre, Composer, Grouping, BPM, Key, Duration, Bitrate,
Comment, Year, Track #, Date Added, Rating (stars), Location, Type, Color, BitDepth/Channels, Preview
(in-library play), ReplayGain, #Last Played / Times Played. Show/hide via header right-click.

Sorting: up to 3 columns (click successive headers). Key column sorts by circle of fifths. Preview
header enables random/shuffle sort.

### Metadata
Read from ID3v2 (MP3), Vorbis comments (FLAC/Ogg), etc. Edited via inline edit, the Properties
dialog, or external taggers + "Import Metadata from File Tags." **Mixxx does not write to audio files
by default** — edits live in the DB unless Track Metadata Synchronization is enabled.

### Crates vs Playlists (key difference)
- **Playlists** — ordered, allow duplicates, manual ordering. For planning a set in sequence.
- **Crates** — unordered, no duplicates, no manual ordering. Tag/label semantics (a track can be in
  many). For organizing by mood/genre/energy.

### Auto DJ
A special permanent playlist with automation. Controls: Enable, Fade Now, Skip Track, Transition Time
(seconds; negative = a gap/pause between tracks), Shuffle, Add Random Track, Repeat Playlist.

Transition modes (`TransitionMode` enum, verified in source):
1. **FullIntroOutro** — overlap incoming intro with outgoing outro (uses intro/outro markers).
2. **FadeAtOutroStart** — start the fade at the outgoing track's outro marker.
3. **FixedFullTrack** — fixed-length crossfade.
4. **FixedSkipSilence** — fixed crossfade, skip leading/trailing silence.
5. **FixedStartCenterSkipSilence** — fixed crossfade, start at center, skip silence.

### Search operators
Text fields (with short aliases): `artist`(a), `album`(al), `album_artist`(aa), `title`(t),
`genre`(g), `composer`(cp), `comment`(cm), `grouping`(gr), `crate`, `location`(lo), `directory`/`dir`.
Numeric: `bpm`(b), `bitrate`, `played`, `rating`(r), `track`(tr), `year`(y), `id`, `duration`(du) with
`< <= > >= =` and ranges. Specials: `~key:c#m` (harmonic-compatible), `~bpm:100` (fuzzy),
`bpm:const`, `genre:""` (empty), `-year:1990` (negate), `genre:house | genre:techno` (OR), exact with
`=` or quotes.

### Other library views
- **Computer** (file-manager browser; load non-library files; drag files into the library) + **Quick
  Links** (folder bookmarks).
- **Recordings** (start/stop + browse past recordings).
- **History** (auto-logged per session; rename/lock/merge/export; new session per Mixxx launch).
- **Analyze** (pre-analyze beatgrid/BPM/key/ReplayGain before performance).
- **Missing Tracks** (file gone; record kept to preserve hotcues/beatgrids; Purge removes from DB,
  not disk). **Hidden Tracks** (hide-from-library; unhide restores).

### Importers
iTunes, Traktor, Rhythmbox, Banshee (read their libraries; "Import Playlist"). **Rekordbox** (USB/SD
DB: folders, playlists, beatgrids, hotcues, memory cues→main cue, loops→hotcues). **Serato** (local +
USB crates: hotcues, loops, color, beatgrid; NOT waveforms/gain/Flips/smart-crates).

### Analysis
- **Beat detection:** Queen Mary beat tracker (default) or SoundTouch BPM. Manual BPM
  multiply/divide (50/66/75/133/150/200%).
- **Key detection:** Queen Mary key or libKeyFinder. Camelot/Open-Key/Lancelot notations.
- **ReplayGain:** loudness normalization (ReplayGain 1.0 or EBU R128).

### Database
`mixxxdb.sqlite` in the settings dir holds all metadata, crates, playlists, cues, beatgrids,
ReplayGain, history, Auto DJ.

## 9. Effects

### Architecture
- **4 effect units** (2 shown by default). Each unit = a chain of **up to 3 effect slots** in series
  (source shows `kNumEffectsPerUnit = 4`; the manual/UI exposes 3 by default).
- A unit can be assigned to multiple inputs (so you can exceed 3 effects on a deck).

### Routing targets
Decks 1–4, Microphones, Aux inputs, Main/Master, PFL (headphone), and the L/M/R crossfader buses.

### Parameters & metaknob
- Each effect exposes parameters (hidden until Focus). One **metaknob (super knob)** per effect; each
  parameter links to it with a **link mode**: Inactive, Active, Left side, Right side, Left+right
  (bidirectional), each optionally inverted.
- All time-based parameters are tempo-synced to the deck BPM, **except Reverb**.

### Mix modes (wet/dry)
- **Dry/Wet** (default): Mix knob crossfades dry↔wet.
- **Dry+Wet**: full dry always passes, Mix adds wet on top (good for filter-before-echo chains).

### Complete native effects list (24, verified from `builtinbackend.cpp`)
EQs/isolators: **Bessel4 LV-Mix Isolator**, **Bessel8 LV-Mix Isolator**, **LinkwitzRiley8 Isolator**,
**Biquad Equalizer**, **Biquad Full Kill Equalizer**, **Graphic Equalizer** (8-band), **Parametric
Equalizer**, **Loudness Contour**.
Filters: **Filter** (LPF+HPF), **Moog Ladder 4 Filter**.
Character/time/mod: **Bitcrusher**, **White Noise**, **Stereo Balance**, **Flanger**, **Echo**,
**Autopan**, **Reverb**, **Phaser**, **Metronome**, **Tremolo**, **Pitch Shift**, **Distortion**,
**Glitch**, **Compressor**.
(Plus LV2 plugins on Linux via the LV2 backend.)

### QuickEffect
Per-deck single-knob effect in the mixer. Controls that deck's QuickEffect chain metaknob. Default =
Filter. Right-click recenters; a toggle enables/disables (latching). User-selectable per deck.

### Chain presets
Effect chains can be saved/loaded as presets (controllers can load presets 1–4).

## 10. Recording

- Formats: WAV, AIFF, FLAC, Ogg Vorbis, MP3, Opus (default WAV). MP3/Ogg/Opus expose bitrate/quality;
  FLAC exposes compression level.
- Output: a `Recordings` subfolder of the music dir (custom path configurable).
- Start/stop via toolbar icon (shows running duration), Options menu, or the Recordings view.
- **Create CUE file** option (writes a `.cue` sheet marking when each track started, for re-splitting).
- Custom metadata (artist/title/album) for the recording.
- **Split** by size/time: 650 MB (CD), 700 MB (CD), 1 GB, 2 GB, 4 GB, 60 min, 74 min (CD), 80 min
  (CD), 120 min — continues into a new numbered file automatically.

## 11. Live broadcasting

- Servers: Icecast 2, Icecast 1, Shoutcast 1 (Shoutcast 2 via the Shoutcast 1 protocol with a stream
  name). Uses libshout; MP3 via LAME.
- Formats: MP3 (Icecast + Shoutcast), Ogg Vorbis (Icecast only); Opus/AAC depending on build encoders.
  128–160 kbps recommended.
- Per-profile settings: Type, Host (not a URL), Port (usually 8000), Login (`source` Icecast / `admin`
  Shoutcast), Mount (Icecast, e.g. `/live`), Password, public/private toggle.
- **Up to 16 simultaneous connections** (`BROADCAST_MAX_CONNECTIONS = 16`) — multiple servers/formats
  at once.
- Metadata: artist/title (default or custom), format strings with `$artist`/`$title`, UTF-8 option,
  dynamic Ogg metadata update. Automatic reconnect with a max-retries setting. Public stream
  directory (YP) toggle.

## 12. Vinyl control / DVS

- Timecode media: Serato CV02 / 2.5 Vinyl (best, recommended), Serato Control CD, Traktor Scratch MK1
  (vinyl + CD; MK2 not supported in 2.6), MixVibes DVS V2 (legacy), Pioneer Rekordbox DVS.
- Modes: **Absolute** (pitch + position; needle-drop seeks), **Relative** (pitch only, no needle-drop
  seek), **Constant** (keeps playing at constant speed when signal absent / end-of-record).
- Cueing (relative mode only): **Cue mode** (drop after cue seeks to cue), **Hot Cue mode** (drop
  seeks to nearest hotcue backwards).
- **Lead-in time** dead zone; **signal-quality scope** ("vinyl doughnut"). Needs ≥4 line-level input
  channels; phono must be boosted to line level (interface preamp or Mixxx's software boost slider);
  native low-latency drivers recommended (~10 ms). Single-turntable toggling supported.

## 13. Sampler & preview deck

- **Samplers** — miniature decks (play, gain, sync, repeat, cue, eject). Default **4**
  (`kSamplerCount = 4`), expandable to **64**. Groups `[Sampler1]`…. Saved/loaded as **Sampler Banks**
  (`samplers.xml`); current bank auto-saves on exit, reloads on startup.
- **Preview Deck** — pre-listen in headphones without affecting Played state / play counter /
  History. Group `[PreviewDeck1]`; Ctrl/Cmd+4 or the library Preview column play button.
