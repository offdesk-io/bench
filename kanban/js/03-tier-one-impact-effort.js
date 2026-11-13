'use strict';

/* =========================================================================
   2b. Tier one: impact against effort
   Every task carries two scores, set when it lands. Together they answer "is
   this worth starting next" — matters a lot, costs little, goes first. A task
   missing either one cannot be placed at all, so the board says so out loud
   rather than quietly sorting it as though it scored zero.
   ========================================================================= */

/* IMPACT_N, EFFORT_N, unscored and priorityScore live in core/todo.js, because
   agents/bucket-agent/bucket_work.py needs the same answer to order its queue and a second
   copy of "high is 3" could drift. That file
   is loaded as a classic script above this one, so all four are already in
   scope here. Only the emoji stayed: the picker has no use for them and the
   board is the only thing that draws a card. */
const IMPACT_EMOJI = { high:'🔥', med:'🌤️', low:'🍃' };
/* Sorting is a way of looking at a column, not a change to the file. The owner's own
   order is the file order and it means something, so priority sort never
   rewrites it — which is also why hand-reordering is off while it is on. */
const SORT_KEY = 'bench-sort';
function sortMode(col){ return state.sort[col] === 'priority' ? 'priority' : 'manual'; }
function setSortMode(col, mode){
  if (mode === 'priority') state.sort[col] = 'priority'; else delete state.sort[col];
  try { localStorage.setItem(SORT_KEY, JSON.stringify(state.sort)); } catch (e) {}
}
function readSort(){
  try { return JSON.parse(localStorage.getItem(SORT_KEY) || '{}') || {}; } catch (e) { return {}; }
}

