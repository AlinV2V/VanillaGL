/** Asset conversion utility. */
import { FACTION_TEMPLATES, type FactionTemplateTuple } from './data/faction-templates';

export type UnitReaction = 'hostile' | 'neutral' | 'friendly';

const FACTION = 0;
const FRIENDLY_MASK = 2;
const HOSTILE_MASK = 3;
const ENEMY_FACTIONS = 4;
const FRIEND_FACTIONS = 5;
// ourMask is index 1; kept implicit via tuple access below.

function templateOf(id: number | undefined): FactionTemplateTuple | undefined {
  if (id === undefined) return undefined;
  return FACTION_TEMPLATES[id];
}

export function factionIdForTemplate(templateId: number | undefined): number | undefined {
  return templateOf(templateId)?.[FACTION];
}

/** ReputationRank from SMSG_SET_FORCED_REACTIONS overrides ordinary template hostility. */
export function reactionFromForcedRank(rank: number | undefined): UnitReaction | undefined {
  if (rank === undefined) return undefined;
  if (rank <= 1) return 'hostile'; // hated / hostile
  if (rank >= 4) return 'friendly'; // friendly through exalted
  return 'neutral'; // unfriendly / neutral
}

/** vMaNGOS FactionTemplateEntry::IsHostileTo(target). */
function isHostileTo(viewer: FactionTemplateTuple, target: FactionTemplateTuple): boolean {
  const targetFaction = target[FACTION];
  if (targetFaction) {
    if ((viewer[ENEMY_FACTIONS] as readonly number[]).includes(targetFaction)) return true;
    if ((viewer[FRIEND_FACTIONS] as readonly number[]).includes(targetFaction)) return false;
  }
  const targetOurMask = target[1];
  return (viewer[HOSTILE_MASK] & targetOurMask) !== 0;
}

/** vMaNGOS FactionTemplateEntry::IsFriendlyTo(target). */
function isFriendlyTo(viewer: FactionTemplateTuple, target: FactionTemplateTuple): boolean {
  const targetFaction = target[FACTION];
  if (targetFaction) {
    if ((viewer[ENEMY_FACTIONS] as readonly number[]).includes(targetFaction)) return false;
    if ((viewer[FRIEND_FACTIONS] as readonly number[]).includes(targetFaction)) return true;
  }
  const viewerOurMask = viewer[1];
  const targetOurMask = target[1];
  return (viewer[FRIENDLY_MASK] & targetOurMask) !== 0 || (viewerOurMask & target[FRIENDLY_MASK]) !== 0;
}

/**
 * Reaction of `viewerTemplate` toward `targetTemplate`.
 *
 * Hostile takes precedence over friendly (matches the client's color priority).
 * Unknown templates fall back to neutral — the conservative choice the nameplate
 * plan calls for when faction data is incomplete.
 */
export function getUnitReaction(
  viewerTemplateId: number | undefined,
  targetTemplateId: number | undefined,
  forcedReputationRank?: number,
): UnitReaction {
  const forced = reactionFromForcedRank(forcedReputationRank);
  if (forced) return forced;
  const viewer = templateOf(viewerTemplateId);
  const target = templateOf(targetTemplateId);
  if (!viewer || !target) return 'neutral';
  if (isHostileTo(viewer, target)) return 'hostile';
  if (isFriendlyTo(viewer, target)) return 'friendly';
  return 'neutral';
}

/** Vanilla nameplate/name RGB for a reaction (red / yellow / green). */
export function reactionColor(reaction: UnitReaction): readonly [number, number, number] {
  switch (reaction) {
    case 'hostile':
      return [0.78, 0.0, 0.0];
    case 'friendly':
      return [0.0, 0.78, 0.0];
    default:
      return [0.78, 0.78, 0.0];
  }
}
