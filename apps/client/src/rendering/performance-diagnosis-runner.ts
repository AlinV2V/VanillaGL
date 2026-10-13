import { qaGlobals } from '../qa-globals';
import type { AdvancedPerformanceCaptureOptions } from './performance-runtime';
import { compareDiagnosisScans } from './performance-diagnosis';
import { RENDERER_CATEGORY_NAMES } from './performance-renderer-attribution';
import { downloadPerformanceArtifact } from './performance-capture-export';

type Options = { seconds?: number; label?: string; categories?: string[]; download?: boolean };
const defaults = ['terrain', 'wmo-buildings', 'wmo-doodads', 'terrain-doodads', 'entities', 'particles'];

export function installPerformanceDiagnosis(capture: (options: AdvancedPerformanceCaptureOptions) => Promise<Record<string, unknown>>) {
  let running = false;
  qaGlobals.__vanillaPerfDiagnose = async (options: Options = {}) => {
    if (running) throw new Error('A diagnostic scan is already running.');
    const categories = [...new Set(options.categories ?? defaults)];
    if (!categories.length || categories.some(name => !(RENDERER_CATEGORY_NAMES as readonly string[]).includes(name))) {
      throw new Error(`Choose categories from: ${RENDERER_CATEGORY_NAMES.join(', ')}`);
    }
    const seconds = Number(options.seconds ?? 45);
    if (!Number.isFinite(seconds) || seconds < 5 || seconds > 300) throw new Error('seconds must be between 5 and 300 (per scan).');
    running = true;
    try {
      console.warn('Diagnostic: keep character/camera still and tab visible. 10s baseline, then two category scans. Geometry will temporarily disappear.');
      const base = { gpu: true, download: false, label: options.label ?? 'diagnosis' };
      const baseline = await capture({ ...base, label: `${base.label}-baseline`, seconds: 10 });
      const scans = [];
      for (const order of [categories, [...categories].reverse()]) {
        scans.push(await capture({ ...base, seconds, countdown: 0,
          categoryAblations: { categories: order, settleFrames: 15, sampleFrames: 45 },
        }));
      }
      const ranking = compareDiagnosisScans(scans[0], scans[1]);
      const report = { schema: 'vanillagl.performance-diagnosis/v1', baseline, scans, ranking,
        note: 'Ranking uses the smaller repeated saving, not additive CPU+GPU time. This is a screening experiment, not a controlled benchmark or projected FPS gain. Missing categories are untested. Simulation continues while geometry is hidden.',
      };
      qaGlobals.__vanillaPerfLastDiagnosis = report;
      console.table(ranking);
      console.log('Diagnostic report:', report);
      if (options.download !== false) downloadPerformanceArtifact(`vanillagl-diagnosis-${Date.now()}.json`, 'application/json', JSON.stringify(report, null, 2));
      return report;
    } finally { running = false; }
  };
}
