# 05 — Library, Database, Track Model, Decoding, Analysis, Waveforms

The data layer. Files under `../mixxx-src/src/database`, `src/library`, `src/track`, `src/sources`,
`src/encoder`, `src/analyzer`, `src/waveform`, and `res/schema.xml`.

## 1. Database (SQLite)

- **File:** `mixxxdb.sqlite` in the user settings dir. Opened via Qt `QSQLITE` (URI mode).
- **Schema:** `res/schema.xml` — a **versioned migration log** (`<revision version="N">` with
  `<description>` + `<sql>`), not a single CREATE script. **`kRequiredSchemaVersion = 39`** (verified).
  `SchemaManager::upgradeToSchemaVersion` applies revisions in order; supports forward-compat via
  `min_compatible` (an older app can open a newer DB if compatible).
- **Column-name constants:** `src/library/dao/trackschema.h`, `crateschema.h`.

### Core tables

**`track_locations`** — physical file identity (one per path): `id` PK, `location` (UNIQUE),
`filename`, `directory`, `filesize`, `fs_deleted`, `needs_verification`.

**`library`** — track metadata + analysis state (one per track; `location` FK → `track_locations.id`):
- Metadata: `id`, `artist`, `title`, `album`, `album_artist`, `year`, `genre`, `composer`,
  `grouping`, `tracknumber`, `tracktotal`, `comment`, `url`, `filetype`.
- Audio props: `duration` (FLOAT secs), `bitrate`, `samplerate`, `channels`.
- Analysis: `bpm`, `beats` BLOB + `beats_version` + `beats_sub_version`, `bpm_lock`, `key`, `key_id`,
  `keys` BLOB + `keys_version` + `keys_sub_version`, `replaygain`, `replaygain_peak`, `cuepoint`.
- State: `datetime_added`, `mixxx_deleted` (hidden/purged), `played`, `timesplayed`,
  `last_played_at`, `rating` (0–5), `color`, `source_synchronized_ms`.
- Cover art: `coverart_source/_type/_location/_hash/_color/_digest`.

**`cues`** — cue points (FK `track_id`): `id`, `track_id`, `type` (`CueType` enum), `position` (REAL
frames, −1 = none), `length` (REAL frames, for loops/intro/outro), `hotcue` (−1 = not a hotcue),
`label`, `color`.

**`crates`** + **`crate_tracks`** — unordered tags. `crates`: `id`, `name` UNIQUE, `count`, `show`,
`locked`, `autodj_source`. `crate_tracks`: `(crate_id, track_id)` UNIQUE.

**`Playlists`** + **`PlaylistTracks`** — ordered. `Playlists.hidden` overloads the table:
`PLHT_NOT_HIDDEN=0` (normal), `PLHT_AUTO_DJ=1` (the Auto-DJ queue), `PLHT_SET_LOG=2` (history).
**So Auto-DJ and History are just special hidden playlists.** `PlaylistTracks` has a `position` for
ordering.

**`track_analysis`** — waveform/summary metadata: `id`, `track_id`, `type` (1=waveform, 2=summary),
`version`, `data_checksum`. **The compressed payload lives in a file on disk** (`<settings>/analysis/
<id>`), not the DB; the row holds only metadata + a CRC.

**`directories`**, **`LibraryHashes`** (per-dir content hash for fast rescan), **`settings`** (k/v),
plus external-library mirror tables (`itunes_*`, `traktor_*`, `rhythmbox_*`; Serato/Rekordbox use
runtime temp tables).

### Relationships
```
track_locations (1) ──1:1── library    (by location FK)
library (1) ──< cues
library (1) ──< track_analysis (waveform + summary)
library (M) ──< crate_tracks >── (N) crates
library (M) ──< PlaylistTracks >── (N) Playlists   [Auto-DJ & History = hidden playlists]
directories / LibraryHashes drive the scanner
```

### DAO pattern
`DAO` base (`dao.h`) holds a `QSqlDatabase` + hand-written SQL (no ORM). DAOs: `TrackDAO` (the big
one — loads/saves library+track_locations, resolves paths, detects moved files, hide/purge),
`CueDAO`, `CrateStorage`, `PlaylistDAO`, `AnalysisDao`, `DirectoryDAO`, `LibraryHashDAO`, `SettingsDAO`,
`AutoDjCratesDao`. All owned by **`TrackCollection`** (holds the one DB). Mutations route through
**`TrackCollectionManager`** (single entry point, keeps internal + external collections + the file
scanner consistent).

**`GlobalTrackCache`** (`src/track/globaltrackcache.h`) — an in-RAM identity map (one live `Track`
per id/file, weak refs). This is why a track edited in one view is the same object everywhere.

**Port:** `better-sqlite3` (synchronous, fast) with the same table layout (for Mixxx-DB import
compatibility). Migrations = ordered SQL keyed by `settings('schema_version')` (keep
version + min_compatible). DAOs → repository modules over one handle. `GlobalTrackCache` → a
`Map<trackId, Track>` with `WeakRef`/`FinalizationRegistry`. BLOB columns (`beats`, `keys`) are
protobuf — use `protobufjs` with the `.proto` files for bit-compat, or your own JSON otherwise.

## 2. Track model (`src/track/`)

- **`Track`** (`track.h`) — the live, mutable, thread-safe (recursive mutex) `QObject`. Held via
  `TrackPointer = shared_ptr<Track>`. Holds: file access, a `TrackRecord` (all scalar DB props),
  `QList<CuePointer>` cues, `BeatsPointer` beatgrid, waveform refs, stem info, dirty flag. ~80
  getters/setters, each emitting a typed change signal (`bpmChanged`, `cuesUpdated`, …) that models
  subscribe to.
- **`TrackRecord`** (`trackrecord.h`) — the persisted scalar bundle: `TrackMetadata` (nested
  TrackInfo + AlbumInfo + StreamInfo), id, dateAdded, playCounter, color, rating, bpmLocked,
  mainCuePosition, Keys, coverInfo.
- **Beatgrid: `Beats`** (`beats.h`) — immutable, shared. **Constant tempo** = `{bpm, firstBeat}`;
  **variable tempo** = beat-marker list. Positions are **frame indices**. Rich query API
  (`findNextBeat`, `findClosestBeat`, `findNBeatsFromPosition`, `getBpmInRange`). Serialized as
  protobuf (`proto/beats.proto`: `BeatGrid` for constant, `BeatMap` for variable), versioned
  (`"BeatGrid-2.0"` / `"BeatMap-1.0"`).
- **Cues: `Cue`** (`cue.h`) + `CueInfo` DTO. `CueType` enum: `Invalid, HotCue, MainCue, Beat, Loop,
  Jump, Intro, Outro, N60dBSound`. **Loops, intro/outro, hotcues, and the main cue are all rows in
  `cues`**, distinguished by `type`; loops/regions use `length`.
- **Keys: `Keys`** (`keys.h`) — protobuf `KeyMap` (global key 1–24 = C_MAJOR…B_MINOR, optional
  per-section key changes). `KeyUtils` converts Camelot / Open-Key / Lancelot notations (port these
  tables — they encode harmonic-mixing logic).
- **ReplayGain** (`replaygain.h`) — `{ratio, peak}`.

**Universal convention: time is in frames.** `seconds = frame / sampleRate`. Keep this end-to-end.

## 3. Library UI / feature model (`src/library/`)

Qt model/view. The sidebar is a tree of **features**; the center is a SQL-backed table.

- **`LibraryFeature`** (`libraryfeature.h`) — base for every sidebar item: `title`, `iconName`,
  `sidebarModel()` (child tree), `bindLibraryWidget` (central views), click handlers
  (`activate`/`activateChild`/`onRightClick`), signals (`showTrackModel`, `loadTrack`). Each feature
  is a self-contained MVC bundle.
- **Concrete features:** `MixxxLibraryFeature` (Tracks), `AutoDJFeature`, `PlaylistFeature`,
  `SetlogFeature` (history), `CrateFeature`, `BrowseFeature` (filesystem), `RecordingFeature`,
  `AnalysisFeature`. External importers subclass `BaseExternalLibraryFeature`: `RekordboxFeature`,
  `SeratoFeature`, `ITunesFeature`, `TraktorFeature`, `BansheeFeature`, `RhythmboxFeature`.
- **Track table model:** `TrackModel` (mixin: getTrack by index, search, capabilities) →
  `BaseTrackTableModel` (the `QAbstractTableModel`) → `BaseSqlTableModel` (**the grid↔SQL mapping**:
  `setTable`, `select()` runs `SELECT … WHERE <search> ORDER BY <sort>`, builds a `trackId→row`
  index, max 3 sort columns) → `LibraryTableModel` / `PlaylistTableModel` / `CrateTableModel` / etc.
- **`BaseTrackCache`** — one shared in-memory column index for all internal models. **`ColumnCache`** —
  the stable `Column` enum → physical SQL column-index map (so models use enums regardless of column
  order).
- **Search parser** (`searchqueryparser.cpp`, `searchquery.h`) — query string → a `QueryNode` tree
  where each node has **two** evaluators: `toSql()` (WHERE fragment) and `match(track)` (in-memory).
  Node types: `And/Or/Not`, `TextFilterNode`, `NumericFilterNode`, `YearFilterNode`, `KeyFilterNode`
  (`~` = harmonic), `BpmFilterNode` (`~` fuzzy / halve-double / locked), `DurationFilterNode`,
  `DateAddedFilterNode`, `CrateFilterNode`, `SqlNode`.

**Port:** feature = a sidebar plugin interface (`{id, title, iconName, getChildren, activate,
capabilities, hasTrackTable}` emitting `showTrackModel`/`loadTrack`). `BaseSqlTableModel` = a
paginated SQL-backed virtual table behind a virtualized grid (react-window / TanStack Virtual). Search
parser = a `QueryNode` tree → **parameterized** SQL fragments (port the field aliases + BPM
half/double + key-harmonic logic verbatim).

## 4. Audio decoding (`src/sources/`)

Layered: `AudioSource` (sample rate/channels/length) → `SoundSource` (adds type detection) → per-format
`SoundSourceXXX`. A `SoundSourceProvider` factory per decoder; `SoundSourceProviderRegistry` maps
file-type → priority-sorted providers; **`SoundSourceProxy`** orchestrates (pick provider, open with
strict-then-permissive retry, sync metadata onto the Track).

- Unit = **frame** (interleaved per-channel). Samples = `CSAMPLE` float32 `[-1,1]`. **Seeking is
  implicit** — the requested `frameIndexRange().start()` is the seek target (no separate `seek()`).
- Format → library: FLAC=libFLAC, MP3=libmad+libid3tag, Ogg=libvorbisfile, Opus=libopusfile (48k),
  WAV/AIFF=libsndfile, M4A/AAC=libmp4v2+FAAD2 (runtime `dlopen` to dodge patents),
  WavPack=WavPack, mod/xm/it=libmodplug, **everything-fallback=FFmpeg** (kept at lowest priority),
  macOS=CoreAudio, Windows=MediaFoundation, stem.mp4=`SoundSourceSTEM` (wraps 4 FFmpeg sources).
- Metadata via **TagLib** (`MetadataSourceTagLib`); writes are atomic (temp-file + rename). Mixxx does
  not write tags by default.
- **Stem files**: `.stem.mp4` = MP4 with 5 stereo streams (master + 4 stems) + a JSON atom. Output as
  stereo (mix on the fly) or 8-channel (per-stem volume/EQ in the engine).

**Port:** the 12-decoder zoo collapses to **one FFmpeg** (Mixxx itself keeps FFmpeg as the universal
fallback). Node: `ffmpeg -i file -f f32le -ac 2 -ar 44100 pipe:1` (`fluent-ffmpeg` or `@ffmpeg/ffmpeg`
WASM). Browser: `AudioContext.decodeAudioData()` → planar `AudioBuffer` (deinterleave at the FFmpeg
`f32le` ↔ AudioBuffer boundary). Tracker modules → `libopenmpt` WASM. Tags → `music-metadata`
(read). **AAC is a deliberate license choice** (licensed FFmpeg build or WebCodecs platform AAC) — see
our existing memory on the Loukai AAC encoder decision.

## 5. Encoders (`src/encoder/`)

`Encoder` interface: `initEncoder`, `encodeBuffer(samples)`, `updateMetaData`, `flush`. Output pushed
through an `EncoderCallback` sink (`write/tell/seek`) — the encoder doesn't know whether the sink is a
file recorder or an Icecast streamer. `EncoderFactory` dispatches: WAV/AIFF=libsndfile, FLAC=libsndfile,
MP3=LAME, Ogg=libvorbisenc, Opus=libopus, AAC=FDK-AAC (runtime-loaded). **Port:** a Node
Writable/Transform stream; all backends collapse to FFmpeg `-c:a libmp3lame|libvorbis|libopus|flac|aac
|pcm_*`. Pure-JS MP3 = `lamejs`. WAV/AIFF are trivial (header + raw PCM) — cheapest "render mix to file".

## 6. Analyzers (`src/analyzer/`)

`Analyzer` interface: `initialize(track, sr, ch, len)`, `processSamples(in, count)`,
`storeResults(track)`, `cleanup()`. Audio fed as interleaved stereo float
(`kAnalysisChannels=2`, `kAnalysisFramesPerChunk=4096`, fast mode = first 60 s, native sample rate).

- **AnalyzerBeats** — default `AnalyzerQueenMaryBeats` (qm-dsp onset + `TempoTrackV2`, variable
  tempo) or legacy `AnalyzerSoundTouchBeats` (single constant BPM).
- **AnalyzerKey** — `AnalyzerQueenMaryKey` (qm-dsp HPCP) or `AnalyzerKeyFinder` (libKeyFinder).
- **AnalyzerGain** — ReplayGain 1.0. **AnalyzerEbur128** — ReplayGain 2.0 / EBU R128 (libebur128, the
  modern default; gain = `-18 LUFS - measured`).
- **AnalyzerSilence** — pure C++, threshold −60 dB (0.001f); places N60dBSound/main/intro/outro cues.
- **AnalyzerWaveform** — see §7.

Scheduling: `AnalyzerThread` (one worker; pulls tracks from a lock-free SPSC queue, decodes 4096-frame
chunks, fans out to every analyzer). `TrackAnalysisScheduler` — a thread pool
(`max(1, idealThreadCount())` workers for batch), FIFO queue + in-flight `Set`, aggregates progress.

**Port:** orchestration maps cleanly (Node `worker_threads`, one track/worker, `os.cpus().length`
workers). The DSP is the hard part:
- **Beats/Key/Loudness:** **essentia.js** (WASM) covers all three in one dependency
  (`RhythmExtractor2013`/`BeatTrackerMultiFeature`, `KeyExtractor`, EBU R128) — won't be bit-identical
  to qm-dsp. For Mixxx-library parity, compile qm-dsp + libebur128 to WASM.
- **Loudness alone** ports cleanly (libebur128 → WASM is tiny). **Silence** is trivial JS
  (scan for `abs >= 0.001`).

## 7. Waveform generation/storage (`src/waveform/`, `analyzer/analyzerwaveform.cpp`)

- **Data model:** one `WaveformData` per channel per visual sample; each band (All/Low/Mid/High) is an
  8-bit **peak** (max-of-abs, **not** RMS). Two resolutions in one pass: **detailed** (~441 visual
  samples/sec) + **summary/overview** (fixed 3840 samples for the whole track). The 4-band split uses
  4th-order Bessel filters (crossovers 600 Hz, 4000 Hz).
- **Serialization:** protobuf (`proto/waveform.proto`), versioned (`"Waveform-5.0"` /
  `"WaveformSummary-5.0"`). `WaveformFactory` decides reuse (current / keep / remove-known-buggy).
- **Storage:** `WaveformData[] → protobuf → qCompress (zlib) → CRC → file at <settings>/analysis/<id>`
  (atomic). The `track_analysis` row holds only metadata + checksum.

**Port:** precompute **peak (max-abs)** buckets once via `OfflineAudioContext` + `getChannelData()` or
ffmpeg; 4-band via 3 `BiquadFilterNode`s in an `OfflineAudioContext`. Off-the-shelf: BBC
`audiowaveform` (CLI), `waveform-data.js` (its `resample()` = detailed→summary), `wavesurfer.js`
(render, accepts precomputed peaks). Store as `Uint8Array` (0–255, tiny), gzipped into a SQLite BLOB
(simpler than the separate-file scheme, fine at this size), with version + crc32 for skip-if-current.
**`AnalyserNode` is NOT for this** (it's real-time FFT) — use it only for live visualization.

## 8. Cross-cutting data conventions (replicate these)
1. **Frames are the universal time unit** (beats/cues/waveform positions). `seconds = frame / sampleRate`.
2. **Samples are float32 `[-1,1]`** everywhere internally.
3. **Versioned serialized blobs** (beats/keys/waveform) with `*_version` + `*_sub_version` so analysis
   is skipped when a current cached result exists.
4. **One identity-mapped live object per track** (`GlobalTrackCache`) so edits propagate everywhere.
5. The **`.proto` files** load verbatim into `protobufjs` if you want real Mixxx DB read/write.
