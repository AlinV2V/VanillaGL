/** Pure Build-5875 Beast Training rules shared by the world decoder, CraftFrame and verifier. */
export type BeastTrainingRecipe = {
  learnedSpell: number;
  name: string;
  rank: string;
  iconId: number;
  requiredLevel: number;
  /** Cumulative points for this rank, as stored in SkillLineAbility.reqtrainpoints. */
  trainingPoints: number;
  skillIds: number[];
  chain: number;
  rankOrder: number;
};

export type BeastTrainingManifest = {
  opener: number;
  families: Record<number, [name: string, primarySkillId: number]>;
  order: number[];
  recipes: Record<number, BeastTrainingRecipe>;
  targetRanks: Record<number, [chain: number, cumulativeTrainingPoints: number, rankOrder: number]>;
};

export type BeastTrainingPet = {
  petFamily?: number;
  trainingPoints?: number;
  spellState?: { spells: readonly { action: number }[] };
};

export type BeastTrainingRecipeState = BeastTrainingRecipe & {
  teachingSpell: number;
  /** Incremental price after vMaNGOS refunds the highest known rank in this chain. */
  cost: number;
  used: boolean;
};

/**
 * UNIT_TRAINING_POINTS is an encoded signed field in vMaNGOS Pet::GetDispTP:
 * a negative wire value represents non-negative points, while positive values represent debt.
 */
export function decodePetTrainingPoints(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const signed = raw | 0;
  return signed < 0 ? -signed - 1 : -signed;
}

/** Reproduce Pet::CanLearnPetSpell plus Pet::GetTPForSpell's rank-refund calculation. */
export function resolveBeastTrainingRecipes(
  manifest: BeastTrainingManifest,
  knownTeachingSpells: readonly number[],
  pet: BeastTrainingPet | undefined,
): BeastTrainingRecipeState[] {
  const knownTeachings = new Set(knownTeachingSpells);
  const knownChains = new Map<number, { cost: number; rankOrder: number }>();
  for (const spell of pet?.spellState?.spells ?? []) {
    const target = manifest.targetRanks[spell.action];
    if (!target) continue;
    const [chain, cost, rankOrder] = target;
    const known = knownChains.get(chain);
    knownChains.set(chain, {
      cost: Math.max(cost, known?.cost ?? 0),
      rankOrder: Math.max(rankOrder, known?.rankOrder ?? -1),
    });
  }
  const familyResolved = pet?.petFamily !== undefined;
  const familySkill = familyResolved ? manifest.families[pet.petFamily!]?.[1] : undefined;
  return manifest.order.flatMap((teachingSpell) => {
    const recipe = manifest.recipes[teachingSpell];
    if (!recipe || !knownTeachings.has(teachingSpell)) return [];
    const compatible = recipe.skillIds.includes(270)
      || (!familyResolved || (familySkill !== undefined && recipe.skillIds.includes(familySkill)));
    if (!compatible) return [];
    const known = knownChains.get(recipe.chain);
    return [{
      ...recipe,
      teachingSpell,
      cost: Math.max(0, recipe.trainingPoints - (known?.cost ?? 0)),
      used: (known?.rankOrder ?? -1) >= recipe.rankOrder,
    }];
  });
}
