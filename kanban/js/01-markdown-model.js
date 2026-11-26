'use strict';

/* =========================================================================
   1. Markdown  <->  model
   ========================================================================= */

/* Where the board's server is, when it is not the root of its site:
   os.offdesk.io serves Bench under /bench and removes the prefix before the
   server sees a request. The server says so in /owner.js (window.BENCH_BASE,
   from its BENCH_BASE setting), and a page with no server, or a server at the
   root, has ''. Every request the board makes, every link it draws to the
   server and every address it hands a package goes through benchUrl(). The
   paths in this file, and those the server names in a listing (a report's or
   a backup's url), are the server's own, and become addresses there.
   getJSON() and sendJSON() call it themselves, so a path given to them is the
   server's own too. A full address, or one relative to the page, is left
   alone. */
const BOARD_BASE = (typeof window !== 'undefined' && typeof window.BENCH_BASE === 'string') ? window.BENCH_BASE : '';
function benchUrl(path){
  return (typeof path === 'string' && path.charAt(0) === '/' && path.charAt(1) !== '/') ? BOARD_BASE + path : path;
}

/* The list lives in data/, which is the only folder git ignores and the only
   one Obsidian opens as a vault. The name shown in the header stays todo.md:
   the folder is a fact about where the file is kept, not part of what it is. */
const FILE_URL = '/data/todo.md';
/* The example list, used when there is no real one to read. Absolute rather than
   relative to this page, because a host can serve index.html at the root as
   readily as at /kanban/, and a relative path would only find it in one of the
   two. See loadDemo. */
const DEMO_URL = '/kanban/demo.md';
/* Which Jira boards the Raise a ticket buttons offer. It lives in data/ with
   everything else private: it names a company Jira and an account id, and this
   repo is public. Missing is the normal case for anyone but the owner — the buttons
   simply do not appear. See loadJira. */
const JIRA_URL = '/data/jira.json';
/* Which private folders under data/ exist, and which one FILE_URL and
   JIRA_URL above actually resolve to right now — the server rewrites
   /data/... to /data/<current>/... on its side, so this page never needs to
   know a dataset's name to read or save the list, only to draw the dropdown
   and to ask for a different one. See loadDatasets. */
const DATASETS_URL = '/datasets.json';

