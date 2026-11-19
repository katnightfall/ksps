---
quest: A Shell of a Friend
key: a_shell_of_a_friend
status: untested
tested:
tester:
model:
commit:
cache: osrs-242_2026-11-11
start: the Juvenile Snail, on the island west of fairy ring ALQ (Haunted Woods)
travel:
---

# A Shell of a Friend

Released 11 November 2026 (Quest Month, week two). Built from the OSRS Wiki alone: there is no live capture of it,
and Quest Helper has no helper for it (its newest source, master `b9b9370` of 3 November 2026, is older than the
quest). Not yet played in the game client, so the status stays untested.

Sources: [A Shell of a Friend](https://oldschool.runescape.wiki/w/A_Shell_of_a_Friend) and its
[quick guide](https://oldschool.runescape.wiki/w/A_Shell_of_a_Friend/Quick_guide),
[Transcript:A Shell of a Friend](https://oldschool.runescape.wiki/w/Transcript:A_Shell_of_a_Friend) (every line the
quest shows is from it), [its journal](https://oldschool.runescape.wiki/w/Transcript:A_Shell_of_a_Friend/Journal),
and the pages of the Juvenile Snail, Leech (A Shell of a Friend), SnelmLover500, Fresh leaves, Dew-covered branch,
Restorative dew, Strong sticks, Tree and Stepping stone (A Shell of a Friend), Pink snelm and Bronze axe (its spawn).

Code: `server/plugins/quests/quests/ShellOfAFriend.Quest.js`; the stepping stone is an entry of
`server/plugins/skills/data/agility-shortcuts.json`. Test: `server/tests/a-shell-of-a-friend.test.cjs`.

## Cache facts

- Quest row 220 (dbrow 17315 `quest_shellofafriend`): 2 Quest Points, members, intermediate, very short; requirements
  Priest in Peril (dbrow 111), Herblore 16 and Construction 15 (not boostable); recommended combat 40; 2,500
  Herblore and 2,500 Construction experience; `endstate` 24.
- Progress: client script 4024 (the quest progress getter) reads varbit `snailquest` (16854, bits 0-6 of varp
  `snailquest_primary` 6250). The name has `snailquest_snail_name` (16855, bits 7-11); no client script reads it.
- NPCs: `snailquest_snail` 16882 (Juvenile Snail, Talk-to), `snailquest_leech` 16883 (Leech, level 39),
  `snailquest_snelmlover` 16884 (Talk-to) and `snailquest_snelmlover_combat` 16885 (level 50). None transform.
- The tree `snailquest_tree_multi` (33159, at 3562,3491) is a multiloc on 16854: a plain tree (33160) at 0-10, the
  shelter (63334) at 11, `Build-shelter` (33161) at 12, and the shelter from 13 on.
- Items 34793 fresh leaves, 34795 dew-covered branch (Strip), 34797 restorative dew, 34799 strong sticks, 34801
  pink snelm. The `snailquest_objects` table (272, rows food1a, food1b, healing, sticks, food2) has its values
  stripped from the client cache.

## Stages (varbit 16854)

Only 24 (the cache's end) and the tree's 12 / 13+ come from the cache; the others are ours, placed so the tree
shows what the Wiki says it shows when.

| Value | After | Journal (Wiki) |
| --- | --- | --- |
| 1 | "Yes." to "Start the A Shell of a Friend quest?" | After starting the quest |
| 2 | the fifth fresh leaf picked up | (missing on the Wiki: ours, below) |
| 3 | the leech killed | After killing the leech |
| 4 | the leaves laid down | After killing the leech |
| 5 | the fifth dew-covered branch picked up | After collecting dew |
| 6 | the dew rubbed on | (missing on the Wiki: ours, below) |
| 7 | a name picked | After naming the snail |
| 12 | "I'll be quick!" | Building a snail shelter |
| 13 | the shelter built | After building the shelter |
| 14 | "I'll be right back! ..." | Collecting food |
| 15 | the fifth fresh leaf picked up again | After collecting the leaves |
| 16 | "What have you done?!" | Avenging the fallen |
| 24 | SnelmLover500 killed | After quest completion |

## Ours (what the sources do not say)

- The stage values above, and the two journal states the Wiki lacks: after the leaves (the next journal's opening
  sentence, "I collected some Leaves from nearby for the Snail to eat.") and after the healing (the paragraph as the
  next journal strikes it, shown current).
- Where the quest's NPCs and items are: each player's own (owner-only) Juvenile Snail at its Wiki tile, the leech
  beside it, SnelmLover500 east of the tree (3564,3492); the fresh leaves, branches, sticks and bronze axe on the
  Wiki's spawn tiles, owner-only, while the player is in the woods round the island and at the stages they belong to.
  The bronze axe shows at stage 12 to a player with no axe they can use.
- "Enough" branches counts the dew already stripped (two a branch); destroying restorative dew brings the branches
  back as destroying a branch does, so a player cannot be left without a balm.
- Stripping: one branch every 3 ticks (the Wiki's recipe) until none are left or the player moves; no animation
  or message (none recorded). Below 16 Herblore (unreachable: the quest needs it to start) "You need a Herblore
  level of 16 to do that."
- The start refusal: "You do not meet all of the requirements to start A Shell of a Friend." (the other quests'
  wording; the Wiki has none). Checked after "Yes.".
- A talk left before a name is picked starts again at the naming lines; one left after it, at "[name] wobbles
  excitedly again...".
- Building the shelter: the axe is checked before the sticks; no animation or message (none recorded); the tree
  turns into the shelter by the varbit.
- SnelmLover500: the combat form appears and attacks when the player arrives on the island (or talks to him); a
  player who leaves finds the talking form again and is attacked on the next arrival. His attack animation is the
  human default (he wields an adamant scimitar; no recording). The Wiki's bonuses (stab 20, slash 20, crush 10
  defence), max hit 6 and speed 4 are a per-NPC combat override, as the leech's (max hit 3, speed 4).
- The leech's fight with the snail: the snail never attacks, and is made whole whenever it falls below half its
  hitpoints (the Wiki: "regenerate health upon falling below half"). A player who gathers the last leaf without
  leaving the island (a telegrab) meets the leech when they talk to the snail.
- The pink snelm is dropped where SnelmLover500 dies, as a kill's drop (the Wiki: "causing him to drop a pink
  snelm"); the scroll pictures it, as the Wiki's scroll image does.
- The destroy note "You'll have to search the Haunted Woods for some more." for all four quest items (the strong
  sticks' page has it without the full stop).
- Not done: the snelm's damage reduction against snails (no snelm has it here), the stepping stone's crossing as
  live plays it (a hop onto the stone and one off, as the other stepping stones).
