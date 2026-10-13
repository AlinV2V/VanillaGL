import type { CpuScopeSnapshot } from './performance-cpu-scopes';
import type { RendererAttributionSnapshot } from './performance-renderer-attribution';

const escapeCsv = (value: unknown): string => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function performanceAttributionCsv(
  scopes: CpuScopeSnapshot | null | undefined,
  renderer: RendererAttributionSnapshot | null | undefined,
): string {
  const rows: unknown[][] = [[
    'record_type', 'id', 'name', 'frame', 'inclusive_ms', 'self_ms', 'calls', 'p50_ms', 'p95_ms',
    'visible_objects', 'submitted_draws', 'triangles', 'instanced_meshes', 'visible_instances', 'slow',
    'parent_id', 'bucket_level', 'bucket_key', 'slow_mean_draws', 'normal_mean_draws', 'slow_draw_uplift',
    'render_delta_ms', 'total_delta_ms', 'gpu_delta_ms', 'far_clip', 'nearest_distance', 'bounds_radius',
    'portal_decision', 'current_group', 'beyond_far', 'outside_frustum', 'portal_hidden_submitted',
  ]];
  for (const scope of scopes?.scopes ?? []) rows.push([
    'scope-summary', scope.id, scope.name, '', scope.inclusiveMs, scope.selfMs, scope.calls, scope.p50Ms, scope.p95Ms,
  ]);
  for (const frame of scopes?.frames ?? []) for (const scope of frame.scopes) rows.push([
    'scope-frame', scope.id, scope.name, frame.id, scope.inclusiveMs, scope.selfMs, '', '', '', '', '', '', '', '', frame.slow,
  ]);
  for (const category of renderer?.categories ?? []) rows.push([
    'category-summary', category.id, category.name, '', '', '', '', '', '', category.visibleObjects.p50,
    category.submittedDraws.p50, category.triangles.p50, category.instancedMeshes.p50, category.visibleInstances.p50,
  ]);
  for (const frame of renderer?.frameSamples ?? []) for (const category of frame.categories) rows.push([
    'category-frame', '', category.name, frame.id, '', '', '', '', '', category.visibleObjects,
    category.submittedDraws, category.triangles, category.instancedMeshes, category.visibleInstances,
  ]);
  for (const bucket of renderer?.wmoDrilldown?.buckets ?? []) rows.push([
    'wmo-bucket', bucket.id, bucket.label, '', '', '', '', '', '', '', bucket.meanDraws, bucket.meanTriangles, '', '', '',
    bucket.parentId, bucket.level, bucket.key, bucket.slowMeanDraws, bucket.normalMeanDraws, bucket.slowDrawUplift,
  ]);
  for (const result of renderer?.wmoDrilldown?.ablation.results ?? []) rows.push([
    'wmo-ablation', result.bucketId, result.label, '', '', '', '', '', '', '', result.drawCallDelta, result.triangleDelta, '', '', '',
    '', result.level, '', '', '', '', result.renderSubmitCpuDeltaMs, result.totalCpuDeltaMs, result.gpuTimeDeltaMs,
  ]);
  for (const group of renderer?.wmoDrilldown?.visibilityAudit?.groups ?? []) rows.push([
    'wmo-visibility-group', group.id, `${group.root} / group ${group.groupIndex}`, '', '', '', '', '', '', '', group.submittedDraws,
    '', '', '', '', '', 'group', '', '', '', '', '', '', '', '', renderer?.wmoDrilldown?.visibilityAudit?.camera.effectiveFarClip,
    group.latestNearestDistance, group.latestBoundsRadius, group.latestPortalDecision, group.latestCurrentGroup,
    group.submittedBeyondFarFrames, group.submittedOutsideFrustumFrames, group.submittedPortalHiddenFrames,
  ]);
  for (const frame of renderer?.wmoDrilldown?.visibilityAudit?.frameSamples ?? []) rows.push([
    'wmo-visibility-frame', '', '', frame.id, '', '', '', '', '', '', frame.submittedDraws, '', '', '', '', '', '', '', '', '', '', '', '', '', '',
    frame.farClip, '', '', '', '', frame.submittedBeyondFarGroups, frame.submittedOutsideFrustumGroups, frame.submittedPortalHiddenGroups,
  ]);
  return rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
}

export function downloadPerformanceArtifact(name: string, type: string, content: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function safePerformanceLabel(label: string): string {
  return label.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'capture';
}
