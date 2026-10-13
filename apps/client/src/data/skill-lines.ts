import { loadRuntimeData } from '../runtime-data';
export type SkillLineMeta = { name: string; categoryId: number };
type Data = { version?: number; skillCategories: Record<number, string>; skillLines: Record<number, SkillLineMeta> };
const data = await loadRuntimeData<Data>('skill-lines', { skillCategories: {}, skillLines: {} });
export const SKILL_CATEGORIES = data.skillCategories;
export const SKILL_LINES = data.skillLines;
