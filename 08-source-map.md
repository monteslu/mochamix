# 08 — Mixxx Source Map

A directory-by-directory map of `../mixxx-src/src` so you can jump to the reference code for any
feature. ~314k lines of C++, Qt-based. (Run `git clone --depth 1 -b 2.6 https://github.com/mixxxdj/
mixxx.git` to regenerate if `../mixxx-src` is gone.)

## Top level

| Path | What |
|------|------|
| `src/main.cpp` | Entry point; Qt app setup; `runMixxx()`; `--qml` switch |
| `src/coreservices.{cpp,h}` | **The service graph / boot order** (see `03` §3) — construct everything |
| `src/mixxxmainwindow.{cpp,h}` | Main window; loads skin; opens sound devices (audio starts here) |
| `src/mixxxapplication.{cpp,h}` | QApplication subclass |
| `CMakeLists.txt` | Build (deps, feature flags like `__RUBBERBAND__`, `__KEYFINDER__`, `__STEM__`) |
| `res/` | All non-code assets (skins, controllers, schema, shaders, qml, translations) |
| `lib/` | Vendored libraries |

## `src/control/` — the control bus (read first; `03` §1)
`controlobject.{cpp,h}` (the named atomic-double), `control.cpp` (the private value), `controlproxy.*`
(per-thread view + `valueChanged`), `controlpushbutton.*` / `controlpotmeter.*` /
`controllinpotmeter.*` / `controllogpotmeter.*` / `controlencoder.*` (control flavors),
`controlvalue.h` (the lock-free value), `pollingcontrolproxy.h`.

## `src/engine/` — the real-time audio engine (`04`)
| Path | What |
|------|------|
| `enginemixer.{cpp,h}` | **The master `process()` loop**; bus mixdown; main/booth/head/talkover |
| `channelmixer.cpp`, `enginexfader.cpp`, `enginepregain.cpp` | Per-channel gain/crossfader/pregain |
| `enginevumeter.cpp`, `enginedelay.cpp`, `enginetalkoverducking.cpp` | VU, output delay, mic ducking |
| `enginebuffer.{cpp,h}` | **Per-deck playback engine**; `processTrackLocked` |
| `channels/enginedeck.cpp`, `enginechannel.cpp`, `enginemicrophone.cpp`, `engineaux.cpp` | Channel types |
| `bufferscalers/enginebufferscalelinear.cpp` | Varispeed scaler (scratch/reverse) |
| `bufferscalers/enginebufferscalerubberband.cpp`, `enginebufferscalest.cpp` | **Keylock** (RubberBand / SoundTouch) |
| `readaheadmanager.cpp` | **Loop/reverse/fractional-position** logic |
| `cachingreader/*` | Chunked background decode + lock-free FIFOs |
| `controls/ratecontrol.cpp` | Folds all speed inputs into one scalar (jog/scratch/sync/reverse) |
| `controls/loopingcontrol.cpp` | Loops, beatloops, `nextTrigger()` |
| `controls/cuecontrol.cpp` | Main cue + 36 hotcues + intro/outro |
| `controls/bpmcontrol.cpp`, `keycontrol.cpp`, `quantizecontrol.cpp`, `clockcontrol.cpp` | The other controls |
| `controls/enginecontrol.{cpp,h}` | **The EngineControl base** (the stackable-feature pattern) |
| `sync/enginesync.cpp`, `internalclock.cpp`, `synccontrol.cpp`, `syncable.h` | **Sync engine** |
| `sidechain/enginesidechain.cpp`, `enginerecord.cpp`, `shoutconnection.cpp` | Record/broadcast (off-RT) |
| `effects/engineeffectsmanager.cpp`, `message.h` | Engine-side effects + the message pipe |

## `src/soundio/` — audio device I/O
`soundmanager.cpp` (owns the PortAudio RT thread; `onDeviceOutputCallback`),
`sounddeviceportaudio.cpp` (the callback), `soundmanagerconfig.*` (sample rate, buffer/latency),
`soundmanagerutil.h` (AudioInput/AudioOutput routing).

## `src/audio/` — audio primitives
`types.h` (ChannelCount, SampleRate, SignalInfo), `frame.h` (FramePos / frame math).
`src/util/types.h` has `CSAMPLE = float`.

## `src/track/` — the track model (`05` §2)
`track.{cpp,h}` (the live `QObject`), `trackrecord.h` (persisted scalars), `trackmetadata.h` /
`trackinfo.h` / `albuminfo.h`, `beats.{cpp,h}` + `beatfactory.h` (beatgrid), `cue.{cpp,h}` +
`cueinfo.h` (cues), `keys.{cpp,h}` + `keyutils.{cpp,h}` (key + notations), `replaygain.h`,
`playcounter.h`, `globaltrackcache.{cpp,h}` (the identity map).

## `src/database/` — DB connection
`mixxxdb.cpp` (connection pool; `kRequiredSchemaVersion = 39`), `schemamanager.cpp` (migration runner).
Schema itself: **`res/schema.xml`** (versioned revisions).

## `src/library/` — library UI + data (`05` §1, §3)
| Path | What |
|------|------|
| `library.{cpp,h}` | Root container; registers all features |
| `trackcollection.{cpp,h}` | Owns the DB + all DAOs |
| `trackcollectionmanager.{cpp,h}` | **Single mutation entry point** |
| `dao/` | `trackdao`, `cuedao`, `playlistdao`, `analysisdao`, `directorydao`, `libraryhashdao`, `settingsdao`, `trackschema.h` |
| `basetracktablemodel.cpp`, `basesqltablemodel.cpp` | **Grid↔SQL mapping** |
| `librarytablemodel.cpp`, `trackmodel.h`, `columncache.cpp`, `basetrackcache.cpp` | Table models + caches |
| `searchqueryparser.cpp`, `searchquery.{cpp,h}` | **Search string → SQL/match tree** |
| `libraryfeature.h` | **The sidebar-feature base** |
| `mixxxlibraryfeature.cpp` | Tracks view |
| `autodj/autodjfeature.cpp`, `autodjprocessor.{cpp,h}` | **Auto DJ** (the 5 transition modes) |
| `trackset/playlistfeature.cpp`, `setlogfeature.cpp`, `crate/cratefeature.cpp`, `crate/cratestorage.cpp` | Playlists / history / crates |
| `browse/browsefeature.cpp` | Filesystem browser |
| `analysis/analysisfeature.cpp`, `recording/recordingfeature.cpp` | Analyze / recordings views |
| `rekordbox/`, `serato/`, `itunes/`, `traktor/`, `banshee/`, `rhythmbox/` | **External importers** |
| `scanner/` | Filesystem library scanner |
| `export/` | Library export |

## `src/sources/` — audio decoding (`05` §4)
`soundsource.{cpp,h}` (base), `soundsourceproxy.cpp` (orchestrator), `soundsourceprovider*.{cpp,h}`
(factory + registry), and per-format: `soundsourceflac/mp3/oggvorbis/opus/sndfile/m4a/wv/modplug/
ffmpeg/coreaudio/mediafoundation/stem.cpp`. Metadata: `metadatasourcetaglib.cpp`. `libfaadloader.cpp`
(runtime AAC).

## `src/encoder/` — output encoders (`05` §5)
`encoder.cpp` (factory), `encoderwave/sndfileflac/mp3/vorbis/opus/fdkaac.cpp`, `encodercallback.h`
(the sink interface).

## `src/analyzer/` — track analysis (`05` §6)
`analyzer.h` (interface), `analyzerthread.cpp` + `trackanalysisscheduler.cpp` (threading),
`analyzerbeats.cpp`, `analyzerkey.cpp`, `analyzergain.cpp`, `analyzerebur128.cpp`,
`analyzersilence.cpp`, `analyzerwaveform.cpp`, `constants.h`. DSP wrappers:
`plugins/analyzerqueenmarybeats/key.cpp`, `analyzersoundtouchbeats.cpp`, `analyzerkeyfinder.cpp`.

## `src/waveform/` — waveform data + rendering (`05` §7)
`waveform.{cpp,h}` (the data model), `waveformfactory.cpp` (serialization/versioning), plus renderers
(`renderers/`) and `waveformwidgetfactory.cpp`. Storage via `library/dao/analysisdao.cpp`.

## `src/effects/` — effects framework (`06` §3)
| Path | What |
|------|------|
| `effectsmanager.cpp` | Owns chains, backends, messenger |
| `effectchain.cpp`, `effectslot.cpp`, `effectparameter.cpp`, `effectknobparameterslot.cpp` | Chain/slot/param + **metaknob link math** |
| `effectsmessenger.cpp`, `defs.h` | Lock-free message pipe; `kNumStandardEffectUnits=4`, `kNumEffectsPerUnit=4` |
| `chains/` | `standardeffectchain`, `quickeffectchain`, `equalizereffectchain`, `outputeffectchain` |
| `backends/effectsbackend.h`, `effectmanifest.h`, `effectprocessor.h` | The abstraction |
| `backends/builtin/builtinbackend.cpp` | **The 24 native-effect registry** |
| `backends/builtin/echoeffect.cpp`, `reverbeffect.cpp`, `filtereffect.cpp`, … | Individual effects |
| `backends/lv2/`, `backends/audiounit/` | LV2 (Linux) + AudioUnit (macOS) plugins |
| `presets/` | Effect chain presets |

## `src/controllers/` — MIDI/HID controllers (`06` §2)
| Path | What |
|------|------|
| `controller.{cpp,h}` | Abstract base |
| `controllermanager.{cpp,h}` | The "Controller" thread; enumerate/load/poll |
| `midi/midicontroller.cpp`, `portmidicontroller.cpp`, `midimessage.h` | MIDI |
| `hid/hidcontroller.cpp`, `bulk/bulkcontroller.cpp` | HID / bulk |
| `legacycontrollermapping*.{cpp,h}`, `midi/legacymidicontrollermappingfilehandler.cpp` | **Mapping XML parsing** |
| `scripting/legacy/controllerscriptenginelegacy.cpp` | The QJSEngine setup |
| `scripting/legacy/controllerscriptinterfacelegacy.{cpp,h}` | **The `engine` JS object** |
| `keyboard/` | Keyboard mapping (`.kbd.cfg`) |
| `rendering/` | Controller screen rendering (2.6) |

## `src/skin/` + `src/widget/` + `src/qml/` — UI (`06` §1)
| Path | What |
|------|------|
| `skin/skinloader.cpp` | Pick + load the configured skin |
| `skin/legacy/legacyskinparser.cpp` | **XML → widget dispatch** (`parseNode`) |
| `skin/legacy/skincontext.{cpp,h}` | **Templating + variables** |
| `widget/wbasewidget.*`, `wwidget.*` | Widget bases (CO connections) |
| `widget/wpushbutton.cpp`, `wknob.cpp`, `wslidercomposed.cpp`, `woverview.cpp`, `wwaveformviewer.cpp`, `wspinny.cpp`, `wvumeter.cpp` | Concrete widgets (187 files) |
| `widget/controlwidgetconnection.{cpp,h}` | **The `<Connection>` binding** |
| `qml/qmlcontrolproxy.h`, `qmlplayerproxy.h`, `qmleffectsmanagerproxy.h`, `qmllibraryproxy.h` | **QML proxies** (the Electron-like binding model) |
| `qml/qmlapplication.cpp`, `qmlwaveformdisplay.h` | QML entry + waveform `QQuickItem` |
| `rendergraph/`, `shaders/` | Scene-graph abstraction + GLSL (port to WebGL/WebGPU) |

## `src/mixer/` — players (`03` §4)
`playermanager.cpp` (**the deck/sampler/preview factory**; `getPlayer(group)`),
`basetrackplayer.cpp` (`BaseTrackPlayerImpl` = a deck), `deck.cpp`, `sampler.cpp`, `previewdeck.cpp`,
`samplerbank.cpp`.

## `src/vinylcontrol/` — DVS (`02` §12)
`vinylcontrol.cpp`, `vinylcontrolxwax.cpp` (timecode decoding via libxwax),
`vinylcontrolmanager.cpp`, `vinylcontrolprocessor.cpp`.

## `src/proto/` — serialization schemas
`beats.proto`, `keys.proto`, `waveform.proto`, `skin.proto`, `headers.proto`. **Load these into
`protobufjs`** for Mixxx DB read/write compatibility.

## `res/` — assets worth reusing
| Path | What |
|------|------|
| `res/schema.xml` | **The SQLite schema** (versioned, portable as-is) |
| `res/controllers/` | **163 mapping XMLs + `midi-components-0.0.js` + `common-controller-scripts.js`** (reuse) |
| `res/skins/` | The 7 bundled skin folders (layout reference) |
| `res/qml/` | The new QML UI (`main.qml`, `Deck*.qml`, …) — closest to our renderer |
| `res/effects/` | Effect chain preset XMLs |
| `res/shaders/` | GLSL for waveforms/spinny (port to WebGL/WebGPU) |
| `res/translations/` | i18n |
