/**
 * Analysis worker entry — re-exports the analysis package worker so Vite bundles
 * it as a module worker. Imported via `new Worker(new URL(...), {type:'module'})`.
 */
import '@dj/analysis/worker';
