# Combat and gameplay

VanillaGL separates server authority, deterministic state, and presentation. Raw packets are decoded in `world.ts` and focused `combat/*` modules; `simulation/*` owns deterministic state; `world-entity-renderer.ts`, `rendering/spell-visual-controller.ts`, `spell-visuals.ts`, UI, and audio consume presentation events.

## Action usability and errors

`combat/action-usability.ts` computes usable, temporarily unusable, or unknown from raw Spell.dbc metadata and live update fields. Checks include death/stun/silence/pacify state, power type/cost/percentage, caster/target aura state, hostile/friendly/dead target workflow, range, reagents/totems, and equipped item class/subclass/inventory masks. `ui/action-combat.ts` owns buttons and targeting workflows; `combat/spell-errors.ts` and `ui/ui-error-frame.ts` route server cast/equipment/range failures into Vanilla-style red UI errors instead of console-only failures.

Build 5875 Spell.dbc fields used by the current base-schema bake include recovery/category recovery 15/16, attributes 5 and Ex2 7, target mask 9, caster/target aura state 12/13, power type/cost 27/28, range 32, projectile speed 33, totems 36–37, reagents 38–45 and counts 46–53, equipment requirements 54–56, effects 56–58, implicit targets A 74–76/B 77–79, radius indices 80–82, visual 107, icon 109, localized name 112, rank 121, percentage cost 148, start recovery 150, family 152 and masks 153–154, and prevention type 156. The bake self-checks Fireball, Frost Armor, Frost Nova, Blizzard, Blink, Vanish, Blind, a totem spell, and weapon requirements before writing output.

## Cooldowns, GCD, and attacks

`combat/cooldowns.ts` combines locally predicted global cooldown with authoritative `SMSG_SPELL_COOLDOWN`, clear/cancel events, and spell/category recovery metadata. StartRecoveryTime 0 means off-GCD; the client does not invent a universal 1.5-second value when raw data says otherwise. Auto-repeat requires both the ranged-slot attribute and AttributesEx2 auto-repeat bit, matching the vMaNGOS predicate. Melee swing timing, attack-speed fields, queued on-next-swing abilities, facing/range failures, and attack animation fallback are separated under `combat/attack-*` and `anim-fallbacks.ts`.

Active duel teams override the ordinary same-faction reaction only at client targeting/attack gates. The server still owns damage, the one-health defeat clamp, winner/completion packets, duel-team clearing, and flag game-object lifetime. `SMSG_DUEL_COMPLETE` preserves vMaNGOS's one-byte `started` value: an interrupted challenge only dismisses duel UI, while an actually-started duel clears local combat presentation and forces one `CMSG_SETSHEATHED(0)` so remote clients receive the stowed weapon state. The party/target popup exposes packet-backed promote, master-looter, uninvite, leave, loot-method, loot-threshold, and active-duel forfeit actions; it does not simulate those transitions locally.

## Damage, schools, and resistance

The server remains authoritative for hit outcome, absorb, resist, block, crit, damage, healing, threat, and aura application. The browser formats and presents combat-log packets; it does not recalculate vMaNGOS damage as truth. School indices 0–6 are physical, holy, fire, nature, frost, shadow, and arcane. Owner update fields provide armor/resistances, attack power, weapon speeds, and min/max damage for paper-doll display. Any predictive formula must be separately validated against Build 5875/vMaNGOS and reconciled to server packets.

## Auras and spell presentation

Unit update fields carry 48 aura spell IDs plus packed flag, level, application/stack, and aura-state arrays. `combat/aura-state.ts` handles the one-based Spell.dbc caster/target states and legacy parry migration. World state applies add/refresh/stack/remove transitions; duration messages populate player timers. Dynamic objects represent persistent area effects and are removed on destroy/despawn packets.

`spell-visual-controller.ts` resolves precast, cast, impact, state, channel, projectile, beam, persistent-area, particle, ribbon, and model lifetimes from baked SpellVisual/M2 data. Effect implicit targets choose caster/unit/destination anchoring. Refreshes reuse state where appropriate; removal tears down models, particles, ribbons, looping audio, and keyed voices. Presentation timing may interpolate, but it never changes whether an aura exists.

## Entity/update-field dependencies

Gameplay consumes `OBJECT_FIELD_ENTRY/TYPE/SCALE`, unit owner/target/channel GUIDs, health/power/max values, level/faction/display/mount, flags/dynamic flags, NPC flags, attack speeds/reach, aura arrays, stats/resistances/attack power, and reconciled player visible-item, XP, coinage, quest, skill, honor, reputation, and combo fields. The exact Build 5875 indices are centralized in `world-entities.ts` and `data/player-field-layout.ts`; comments from later headers are not accepted without compiled-offset verification.

## Vanilla UI authority

The original 1.12.1 FrameXML, extracted from your own client by `npm run setup`, is the layout reference. ActionButton, SpellBook, BuffFrame, CastingBar, TargetFrame, UnitFrame, UIErrorsFrame, and combat-log Lua/XML define interaction and presentation contracts; vMaNGOS defines packet/server behavior.

The party HUD follows the 1.12.1 `PartyMemberFrame` layout: a 37x37 portrait, native status-bar texture, native leader/master-looter markers, and power-type colors. There is no 1.12 party-assistant texture contract in the authoritative FrameXML. Unbound commands never match an empty `KeyboardEvent.code`; this prevents multimedia keys from triggering the unbound keyring command. Keyboard and clickable backpack actions share the same sound-emitting open/close path. Loot item pickup uses `LOOTFRAMEITEMSOUND`, resolved to SoundEntry 1279 `UiLootPickUpItem.wav`; `ITEMGENERICSOUND` remains SoundEntry 123 `MouseOverTarget.wav`. Intermediate quest-objective progress is silent and full completion uses `QUESTLISTCOMPLETE`.
