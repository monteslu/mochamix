/**
 * App — the top-level layout. Two decks flanking a center mixer, Mixxx's classic
 * arrangement (02-functional-spec.md §1). A start gate handles the AudioContext
 * autoplay policy (needs a user gesture).
 */

import { DjProvider, useDj, NUM_DECKS } from './dj-context.js';
import { Deck } from './components/Deck.js';
import { Mixer } from './components/Mixer.js';

function Stage(): React.JSX.Element {
  const { started, start } = useDj();

  return (
    <div className="app">
      <div className="titlebar">
        <span className="brand">internal-dj</span>
        <span className="tagline">built for the love of it</span>
        {!started && (
          <button className="start-audio" onClick={() => void start()}>
            ▶ start audio
          </button>
        )}
      </div>
      <main className="decks">
        <Deck deckIndex={0} />
        <Mixer />
        <Deck deckIndex={1} />
      </main>
      <footer className="statusbar">
        <span>{NUM_DECKS} decks</span>
        <span>{started ? 'audio running' : 'audio idle — click start or load a track'}</span>
      </footer>
    </div>
  );
}

export function App(): React.JSX.Element {
  return (
    <DjProvider>
      <Stage />
    </DjProvider>
  );
}
