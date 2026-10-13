import type { TrainerSpell } from '../world';

/** Native trainer eligibility gate for a selected SMSG_TRAINER_LIST row. */
export const trainerSpellCanLearn = (spell: TrainerSpell | undefined, playerMoney: number, canConfirm: boolean) => !!spell
  && spell.state === 0
  && playerMoney >= spell.cost
  // Both profession flags are zero for ordinary class spells. Vanilla only
  // interprets allowed=0 as a restriction when confirm=1 marks a first-rank
  // primary profession spell.
  && (!spell.primaryProfessionConfirm || spell.primaryProfessionAllowed)
  && (!spell.primaryProfessionConfirm || canConfirm);
