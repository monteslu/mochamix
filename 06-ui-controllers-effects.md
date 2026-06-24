# 06 — UI / Skins, Controllers, Effects

The presentation + input + effects layers. Files under `../mixxx-src/src/skin`, `src/widget`,
`src/qml`, `src/controllers`, `src/effects`, and `res/skins`, `res/controllers`, `res/qml`.

Everything here plugs into the `ControlObject` bus (`03` §1). Internalize that first.

## 1. Skin / widget system (the legacy QWidget UI)

Skins are **XML files parsed at runtime into Qt widgets**. Bundled skins (`res/skins/`, verified):
`Deere`, `Deere (64 Samplers)`, `LateNight`, `LateNight (64 Samplers)`, `Shade`, `Tango`,
`Tango (64 Samplers)`, plus shared `.qss` stylesheets.

A skin folder has a root **`skin.xml`** + dozens of fragment XMLs (`deck.xml`, `mixer.xml`,
`fx_rack.xml`, `library.xml`, …) + a `style.qss`. The `skin.xml` `<manifest>` declares title/author and
an `<attributes>` block that **seeds ControlObject defaults** (num_decks, which panels show) — so a
skin both lays out the UI and sets initial control state.

### LegacySkinParser — XML → widget dispatch
`src/skin/legacy/legacyskinparser.cpp` (2600+ lines). `parseNode()` is a big switch on tag name → C++
widget class:

| XML node | Widget class |
|----------|--------------|
| `<PushButton>` / `<PlayButton>` | `WPushButton` |
| `<CueButton>` / `<HotcueButton>` | `WCueButton` / `WHotcueButton` |
| `<Knob>` / `<KnobComposed>` | `WKnob` / `WKnobComposed` |
| `<SliderComposed>` | `WSliderComposed` |
| `<Overview>` | `WOverview` (track minimap) |
| `<Visual>` | `WWaveformViewer` (scrolling waveform) |
| `<Spinny>` | `WSpinny` (vinyl platter) |
| `<VuMeter>` | `WVuMeter` |
| `<Text>`/`<Label>`/`<Number>`/`<NumberBpm>`/`<NumberPos>` | `WLabel` variants |
| `<WidgetGroup>`/`<WidgetStack>`/`<SizeAwareStack>` | containers |
| `<Template>` | template instantiation |
| `<Library>`/`<LibrarySidebar>`/`<SearchBox>` | library views |
| `<Effect*>` | effect-rack widgets |

All widgets derive from `WBaseWidget` (holds the CO connections). Each widget's `setup(node, context)`
parses its own visual props (pixmaps, states). On creation, every widget gets the keyboard event
filter + the MIDI-learn event filter installed.

### Connections — binding a widget to a ControlObject
A `<Connection>` child binds the widget:
- `<ConfigKey>group,item</ConfigKey>` → resolves to a `ControlObject*`.
- Optional `<Transform>` — value remapping (invert/add/…).
- Direction: `<ConnectValueFromWidget>` (user input) / `<ConnectValueToWidget>` (display feedback);
  default both.
- Emit timing: `<EmitOnDownPress>` / `<EmitOnPressAndRelease>`.
- `<ButtonState>LeftButton|RightButton</ButtonState>` — left/right mouse → different controls.

Creates a `ControlParameterWidgetConnection` holding a `ControlProxy` whose `valueChanged` updates the
widget. `enum DirectionOption { NON, FROM_WIDGET, TO_WIDGET, FROM_AND_TO_WIDGET }`,
`enum EmitOption { NEVER, ON_PRESS, ON_RELEASE, ON_PRESS_AND_RELEASE }`.

### Templating & variables (keeps skins DRY)
`SkinContext` holds `QHash<QString,QString>` variables. `<Variable name="X"/>` expands to X's value
anywhere (paths, sizes, config keys). `<Template src="...">` instantiates a reusable fragment with a
cloned (nested) context; `<SetVariable name="X">v</SetVariable>` sets a variable for that invocation.
Example: one `button_2state_right.xml` template, instantiated per deck with `Group=[Channel1]` etc., so
`<ConfigKey><Variable name="Group"/>,pitch_up</ConfigKey>` resolves to `[Channel1],pitch_up`. Scaling:
`m_scaleFactor` multiplies `<Size>`/`<Pos>` (the `f` suffix marks scalable values); `.qss` handles
fonts/colors.

### The newer QML UI (2.6 / 3.0 direction) — closest analog to Electron
`src/qml/` + `res/qml/` (`main.qml`, `Deck*.qml`, `Mixer.qml`, `EffectSlot.qml`, `WaveformShader.qml`).
Declarative UI bound to **proxy QObjects**: `QmlControlProxy` (the QML equivalent of a `<Connection>` —
exposes `group`/`key`/`value`/`parameter` as bindable properties), `QmlPlayerProxy`,
`QmlEffectsManagerProxy`, `QmlLibraryProxy`, etc. `QmlWaveformDisplay` renders via `src/rendergraph/`
(an abstraction over the scene graph with scenegraph + opengl backends, sharing GLSL shaders from
`src/shaders/` between legacy and QML UIs).

**This QML+proxy model is exactly what an Electron renderer is:** declarative UI bound to a proxy whose
properties mirror ControlObjects.

### Our decision: Mixxx as visual reference, React + GPU canvases as the implementation
We take **visual cues and UI organization** from Mixxx's skins (layout, control grouping, proportions)
but **rebuild the UI in React** (DOM/CSS for layout + widgets) with **`<canvas>` for the WebGL/WebGPU
surfaces** (waveforms, overview, spinny, visualizations). We do *not* port the XML-skin parser. The
binding is a `useControl("[group]","key")` hook over the control store (the React analog of a
`<Connection>` / `QmlControlProxy`). Porting a Mixxx skin = use its layout XML as a reference for *what
goes where*, then build React components + canvas surfaces. Rationale and the React/canvas split live in
`10` §3a; the per-widget mapping table is just below.

### Skin → Electron mapping
| Mixxx | Electron |
|-------|----------|
| Skin = XML widget tree | HTML/JSX component tree (React/Vue/Svelte) |
| `LegacySkinParser` dispatch | a component registry: node type → component |
| `WPushButton`/`WKnob`/`WSliderComposed` | `<PushButton>`/`<Knob>`/`<Slider>` components |
| `WOverview`/`WSpinny`/`WWaveformViewer` | `<canvas>`/WebGL/WebGPU (GLSL ports largely) |
| `<Connection>` binding | a hook: `useControl("[Channel1]","play") → [value, setValue]` |
| `DirectionOption` | controlled-component pattern (read store to display, dispatch on input) |
| `<Transform>` | a JS transform fn in the binding |
| `<Variable>`/`<Template>` | component props + composition (`<DeckButton group="[Channel1]"/>`) |
| `m_scaleFactor`, `.qss` | CSS `rem`/`scale()`, CSS variables, devicePixelRatio |
| `QmlControlProxy` | the IPC-backed control hook (the closest existing analog) |

## 2. Controller system (`src/controllers/`)

### Classes & lifecycle
`Controller` (`controller.h`) = abstract base, one per device. Subclasses: `MidiController`
(→ `PortMidiController`, `Hss1394Controller`), `HidController`, `BulkController`. Holds the mapping
(`LegacyControllerMapping`) + a per-device `ControllerScriptEngineLegacy` (JS engine).
**`ControllerManager`** runs all controllers on its own high-priority "Controller" thread; enumerates
devices at startup (no hotplug), loads mappings, opens devices; polls at **1 ms (5 ms Linux)** (HID
uses a callback thread, no poll).

### Mapping file format (XML + linked JS)
`.midi.xml` / `.hid.xml`, root `<MixxxControllerPreset>`:
- `<info>` (name/author/description).
- `<controller id="...">` with `<scriptfiles><file filename functionprefix/>` (the prefix namespaces
  `init`/`shutdown`/`incomingData`; `common-controller-scripts.js` always added).
- `<controls>/<control>` (input): `<group>`+`<key>` (target ConfigKey), `<status>` (MIDI status byte),
  `<midino>` (control/note), `<options>` (flags incl. **`<script-binding/>`** → route to a JS function
  whose name is `<key>`).
- `<outputs>/<output>` (LED feedback): source CO + status/midino bytes + `<on>`/`<off>` + min/max band.

Direct binding example (CC 17 → crossfader): `<group>[Master]</group><key>crossfader</key>
<status>0xB0</status><midino>17</midino>`. Script binding: `<key>` becomes a JS function name, with
`<options><script-binding/></options>`.

### The JS scripting engine & the `engine` global
A **`QJSEngine`** with globals `controller`/`midi`/`console` and the **`engine`** object
(`ControllerScriptInterfaceLegacy`). The full API:

| Method | Purpose |
|--------|---------|
| `engine.getValue/setValue(group,name[,v])` | read/write a ControlObject |
| `engine.getParameter/setParameter/getParameterForValue` | normalized 0..1 |
| `engine.getDefaultValue/getDefaultParameter` / `reset` | defaults |
| `engine.getSetting(name)` | read a mapping `<settings>` value |
| `engine.makeConnection(group,name,cb)` / `makeUnbufferedConnection` | bind a CO-change callback (returns `{disconnect, trigger}`) |
| `engine.connectControl` (deprecated) / `trigger(group,name)` | legacy connect / force-fire |
| `engine.beginTimer(ms,cb,oneShot)` / `stopTimer(id)` | timers (≥20 ms) |
| `engine.scratchEnable(deck,intervalsPerRev,rpm,alpha,beta,ramp)` / `scratchTick` / `scratchDisable` / `isScratching` | alpha-beta scratch filter |
| `engine.softTakeover(group,name,set)` / `softTakeoverIgnoreNextValue` | prevent value jumps |
| `engine.brake` / `spinback` / `softStart` (+ `is*Active`) | motor ramp effects |
| `engine.convertCharset(charset,value)` | encode strings for device screens |

### Input flow: MIDI bytes → ControlObject
`MidiController::processInputMapping`: if `script-binding`, call the JS function with signature
**`function(channel, control, value, status, group)`** (which typically ends in `engine.setValue(...)`);
else `computeValue()` applies invert/diff/rot64/spread64/14-bit/button/switch transforms and does
`pCO->setValueFromMidi(...)`. **Output (LED):** a `MidiOutputHandler` subscribes its source CO; on
change it computes the on/off byte and calls `sendShortMsg`.

### The Components JS library (`res/controllers/midi-components-0.0.js`)
An OO layer over the raw API. Base `Component` (group, inKey/outKey, midi pair, `input()`/`output()`,
`connect()→makeConnection`). Subclasses: `Button` (push/toggle; `PlayButton`/`CueButton`/
`HotcueButton`), `Pot` (faders/knobs + softTakeover + 14-bit), `Encoder`, `ComponentContainer`
(+ shift layers), `Deck` (retargets all child components between `[ChannelN]` groups), `JogWheelBasic`
(scratch), `EffectUnit`. Most community mappings build a container named after their `functionprefix`,
populate it with these, and implement `init`/`shutdown`.

### Controller → Electron mapping (the big compatibility win)
| Mixxx | Node |
|-------|------|
| `MidiController` | `easymidi`/`@julusian/midi` (RtMidi); `device.on('message', …)` — no poll timer |
| `HidController` | `node-hid`; `device.on('data', …)` (already threaded) |
| `ControllerManager` | a `DeviceManager` module; per-device JS optionally in a `worker_thread` for scratch timing |
| Mapping XML+JS | keep mappings as JS; optionally parse legacy `.midi.xml` with `fast-xml-parser` |
| `engine.getValue/setValue` | `store.get/set`; `makeConnection` → `store.on('change:[group],key', cb)` |
| `QJSEngine` + `engine` global | plain Node; run untrusted mappings in `node:vm` / a worker with a constructed `engine`; `beginTimer` → `setInterval/setTimeout` |
| `computeValue` MIDI options | port verbatim (pure fn) |
| **`midi-components-0.0.js`** | **reuse almost as-is** — depends only on `engine`/`midi`/`console` globals |

**Keep the `engine`/`midi`/`console` global contract + the `init/shutdown/incomingData` +
`(channel,control,value,status,group)` signature identical, and hundreds of existing Mixxx mappings in
`res/controllers/` run nearly unchanged.** This is the single biggest reuse opportunity in the whole
project.

## 3. Effects framework (`src/effects/`)

### The two-thread split (most important fact)
Two parallel hierarchies talking only through a lock-free message pipe:
- **Main/GUI:** `EffectsManager`, `EffectChain`, `EffectSlot`, `EffectParameter`, the immutable
  `EffectManifest`. Own the ControlObjects; do all heap allocation.
- **Audio:** `EngineEffectsManager`, `EngineEffectChain`, `EngineEffect`, `EffectProcessor`,
  `EffectState`.

Heap allocation always on the main thread → the audio callback never blocks. Maps directly onto
main/renderer ↔ AudioWorkletProcessor.

### Object hierarchy (main side)
```
EffectsManager
 ├─ 4 StandardEffectChains (the visible effect units)
 ├─ OutputEffectChain (master out)
 └─ per-deck EqualizerEffectChain + QuickEffectChain
EffectChain
 ├─ 4 EffectSlots (kNumEffectsPerUnit = 4)
 ├─ ControlObjects: mix, superParameter (superknob), enabled, mixMode
 └─ enabled input channels (routing)
EffectSlot → EffectManifest + EngineEffect twin + metaknob + parameter slots
```

### Backend abstraction
`EffectsBackend` interface: `getEffectIds`, `getManifest(id)`, `createProcessor(manifest)`.
`EffectBackendType { BuiltIn, AudioUnit, LV2 }`. **`BuiltInBackend`** (`backends/builtin/
builtinbackend.cpp`) is a static registry of the 24 native effects (see `02` §9). **`LV2Backend`**
wraps lilv (Linux plugins) — proving the manifest/processor abstraction is host-agnostic.
`EffectManifest`/`EffectManifestParameter` describe an effect as pure data: `ParameterType{Knob,Button}`,
`ValueScaler{Linear,Logarithmic,Integral,Toggle}`, `LinkType{None,Linked,LinkedLeft,LinkedRight,
LinkedLeftRight}`, min/default/max, neutral point, `addDryToWet`, `effectRampsFromDry`.

### Audio processing
`EffectProcessor::process(inputHandle, outputHandle, in, out, engineParameters, enableState,
groupFeatures)`. `EffectProcessorImpl<State>` (CRTP) keeps **DSP separate from state**: a 2-D
`m_channelStateMatrix[input][output]` of `EffectState`; dispatches to the subclass's
`processChannel(state, in, out, …)`. Real effects (Echo: ring-buffer delay using
`groupFeatures.beat_length` for tempo sync, ramped gains, clears buffer on disable). Buffers are
stereo-interleaved float; `EngineParameters` gives sampleRate/channelCount/samplesPerBuffer.

### Engine side & message passing
`EngineEffectsManager::onCallbackStart()` drains the message pipe and applies all pending graph
changes **at the top of each callback** (the one safe mutation point). Chains bucketed by stage
(Prefader = EQ; Postfader = effect units/QuickEffect). Mix modes: `DrySlashWet` (`in*(1-mix)+wet*mix`)
vs `DryPlusWet` (`in+wet*mix`), with an `EngineEffectsDelay` aligning dry to latent wet.
`EffectsMessenger` owns a lock-free `MessagePipe`; `EffectsRequest` is a tagged union (ADD/REMOVE
CHAIN/EFFECT, ENABLE/DISABLE for channel, SET params). The main thread frees request objects only
after the engine confirms (deferred-free GC, since C++ has no GC + a hard-RT thread).

### Metaknob / superknob (3 levels)
chain superknob → each slot's metaknob → per-parameter link math switching on `LinkType`: `Linked`
(1:1 around neutral), `LinkedLeft` (left half of the knob), `LinkedRight` (right half),
`LinkedLeftRight` (V-shape), optional inversion + soft-takeover. This is the **Filter** trick: LPF is
`LinkedLeft` neutral 1.0, HPF is `LinkedRight` neutral 0.0, so one knob sweeps lowpass→neutral→highpass.

### Chain types & routing
| Chain | Stage | Slots | Routing |
|-------|-------|-------|---------|
| `StandardEffectChain` | Postfader | 4 | all channels; unit N defaults to deck N |
| `QuickEffectChain` | Postfader | 4 | one deck |
| `EqualizerEffectChain` | **Prefader** | 1 | one deck (legacy `filterLow/Mid/High` aliases) |
| `OutputEffectChain` | Postfader | 1 | master out (mix forced 1.0) |

### Effects → Web Audio mapping
| Mixxx | Web Audio |
|-------|-----------|
| `EngineEffectChain` (series + dry/wet + delay) | subgraph: `input→[nodes]→wetGain`, `input→dryDelay→dryGain`, summed |
| `EngineEffect` | one `AudioWorkletNode` per effect, or native nodes: `BiquadFilterNode` (Filter/EQ), `ConvolverNode` (Reverb), `DelayNode`+feedback (Echo), `WaveShaperNode` (Distortion) |
| Prefader/Postfader | EQ chain before the deck fader GainNode, effect units after |
| `EffectProcessor::processChannel` | `AudioWorkletProcessor.process` (fixed 128-frame quantum; ramp inside `process()`) |
| `EffectState` per (in,out) | one node instance per (deck × slot); PFL/main = separate instances |
| `EffectManifest` | a JSON descriptor `{id, name, parameters:[{id,type,scaler,min,default,max,linkType}], addDryToWet}` |
| `BuiltInBackend` registry | `Map<id, {manifest, createNode(ctx)}>` |
| metaknob link math | pure JS `applyMetaknob(meta, link, neutral, inverted)` |
| `EffectsMessenger`/`EffectsRequest` | `node.port.postMessage({type, …})`; `groupFeatures` (beat length) posted per tick |
| deferred-free GC / `onCallbackStart` | **not needed** — Web Audio applies graph changes atomically at quantum boundaries; GC frees detached nodes; just keep allocation out of `process()` |
