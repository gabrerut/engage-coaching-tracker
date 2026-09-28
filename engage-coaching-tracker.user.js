// ==UserScript==
// @name         Engage Coaching Tracker
// @namespace    http://tampermonkey.net/
// @version      42.14
// @description  Elevate + Positive coaching tracker on QuickSight. Auto-pulls the coaching lists, cross-references the live Find People on-site roster, and flags on-site AAs with pending coachings. Firebase-synced completions, one-click Done, live in-progress claims. Auto-updates from GitHub.
// @author       Orcha + Eitan Wiernik + branoble + gabrerut
// @match        https://atoz.amazon.work/engage/*
// @match        https://*.quicksight.aws.amazon.com/*
// @match        https://na.store-management.f3.amazon.dev/*
// @match        https://*.store-management.*.amazon.dev/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      engage-coaching-tracker-default-rtdb.firebaseio.com
// @connect      store-management.f3.amazon.dev
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/gabrerut/engage-coaching-tracker/main/engage-coaching-tracker.user.js
// @downloadURL  https://raw.githubusercontent.com/gabrerut/engage-coaching-tracker/main/engage-coaching-tracker.user.js
// ==/UserScript==

(function() {
    'use strict';

    // === AUTO-UPDATE: DISABLED (v37) ===
    // This tool auto-pulls its data (QuickSight coachings + Engage on-site) and syncs
    // via Firebase, so NO manual script updates are ever required. The old author-hosted
    // update check + "Update Available" banner (axzile / branoble gist) has been removed
    // so the team is never nagged or pushed a different version. Frozen, stable handoff.
    var CURRENT_VERSION = '42.14';


    // (v37) Legacy meal/punch data source removed — this is now an Elevate-coaching-only tool.
    var GRAPHQL_ENDPOINT = 'https://atoz.amazon.work/apis/AtoZEngageNA/graphql/access';

    var TYPE_CONFIG = {
        // v38: Elevate + Positive only. Meal/Punch/TOT/Quality/Safety removed (no data source, not tracked).
        ELEV:  { bg: '#E74C3C', label: 'Elevate' },
        POS:   { bg: '#10B981', label: 'Positive' }
    };
    var DEFAULT_TYPE = { bg: '#6c757d', label: 'Coach' };

    var trackedByEmpId = {};
    var trackedByLogin = {};
    var elevateByLogin = {};
    var submittedByLogin = {}; GM_setValue('elevateSubmittedHide', '{}');
    // v41.37: purge malformed completion keys (date leaked into the metric, e.g.
    // 'login|Positive Reinforcement Conversation|2026-09-26|2026-09-26') that caused duplicate
    // Done-Today rows and undo mismatches. Rewrite each key to login|metric|DATE with exactly one
    // trailing date; drop any extra embedded date segment.
    (function(){
        try {
            var comp = JSON.parse(GM_getValue('elevateCompleted', '{}'));
            var fixed = {}, changed = false;
            Object.keys(comp).forEach(function(k){
                var parts = k.split('|');
                // collect trailing date segments
                var dates = [];
                while (parts.length && /^\d{4}-\d{2}-\d{2}$/.test(parts[parts.length-1])) { dates.unshift(parts.pop()); }
                var login = parts.shift() || '';
                var metric = parts.join('|');                 // metric with any embedded dates removed
                var lastDate = dates.length ? dates[dates.length-1] : '';
                var clean = login + '|' + metric + (lastDate ? ('|' + lastDate) : '');
                if (clean !== k) changed = true;
                // keep the most recent record if collision
                if (!fixed[clean] || (comp[k].timestamp||0) > (fixed[clean].timestamp||0)) fixed[clean] = comp[k];
            });
            if (changed) { GM_setValue('elevateCompleted', JSON.stringify(fixed)); console.log('[CoachTracker] v41.37 cleaned malformed completion keys'); }
        } catch(e) {}
    })(); // v41.20: never hide from scraped 'Submitted By' — it over-hid all Elevate
    var positiveByLogin = {}; // Positive reinforcement coachings keyed by login
    var cycleTimeByLogin = {}; // Cycle time data keyed by login
    var coachingErrDetails = {}; // NEW: keyed by login -> array of error detail objects
    var dataLoaded = false;
    var engageEmployees = [];
    var currentMatches = [];
    var managerLogins = [];
    var pageCount = 0;
    var completedArchive = {}; // Stores full alert data for completed items so they can be restored

    // === COMPLETION STATE ===
    // The coaching log is the SINGLE SOURCE OF TRUTH for completions.
    // This function derives the effective completed state from the log.
    // It is called after every log change and after every pull.
    // v39.2: WEEK-SCOPED completions. Old bug: completion key was login|metric with NO week, so a
    // coaching completed in a prior corporate week suppressed (or lingered on) the current week's list.
    // Fix: key completions by login|metric|week where week = the coaching's "Pre Week Begin" date.
    // currentCoachingWeek is set from the scraped rows (the max/most-recent Pre Week Begin seen).
    var currentCoachingWeek = GM_getValue('current_coaching_week', '');

    // v41: DAILY tracker — completions are scoped to TODAY (login|metric|YYYY-MM-DD).
    // Prior days auto-drop (a new day = fresh slate). The optional 3rd arg is ignored now;
    // we always key by the local calendar day.
    function todayKey() {
        var d = new Date();
        return d.getFullYear() + '-' + ('0'+(d.getMonth()+1)).slice(-2) + '-' + ('0'+d.getDate()).slice(-2);
    }
    function ckey(login, metric) {
        return (login || '').toLowerCase() + '|' + (metric || '') + '|' + todayKey();
    }

    function buildCompletedFromLog() {
        var completed = {};
        // Process log oldest-first so latest action wins. Key is week-scoped (login|metric|week).
        for (var i = 0; i < coachingLog.length; i++) {
            var entry = coachingLog[i];
            if (!entry.login || !entry.metric) continue;
            var key = ckey(entry.login, entry.metric);
            if (entry.action === 'completed') {
                completed[key] = { timestamp: entry.timestamp, completedBy: entry.completedBy || 'unknown', week: entry.week || '' };
            } else if (entry.action === 'unmarked') {
                delete completed[key];
            }
        }
        GM_setValue('elevateCompleted', JSON.stringify(completed));
        return completed;
    }

    // Check if a login|metric is completed (uses log-derived cache)
    function isElevateCompleted(login, metric, week) {
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        return !!completed[ckey(login, metric, week)];
    }
    function getLeaderLogin() {
        var login = GM_getValue('leader_login', '');
        if (!login) {
            login = prompt('Engage Coaching Tracker\n\nEnter YOUR login (alias) to track who completes coachings:');
            if (login && login.trim().length >= 3) {
                login = login.trim().toLowerCase();
                GM_setValue('leader_login', login);
            } else {
                return '';
            }
        }
        return login;
    }

    // === CSV PARSER ===
    function parseCSVLine(line) {
        var result = [], current = '', inQuotes = false;
        for (var i = 0; i < line.length; i++) {
            var c = line[i];
            if (c === '"') {
                if (inQuotes && i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
                else inQuotes = !inQuotes;
            } else if (c === ',' && !inQuotes) { result.push(current); current = ''; }
            else current += c;
        }
        result.push(current);
        return result;
    }

    function parseElevateCSV(text) {
        var lines = text.replace(/\r/g, '').split('\n');
        if (lines.length < 2) return 0;
        var header = parseCSVLine(lines[0].replace(/^\uFEFF/, ''));
        var col = {};
        for (var i = 0; i < header.length; i++) {
            var h = header[i].toLowerCase().trim();
            if (h === 'associate id') col.login = i;
            else if (h === 'full name') col.name = i;
            else if (h === 'metric name') col.metric = i;
            else if (h === 'submitted by') col.submitted = i;
            else if (h === 'form url') col.form = i;
            else if (h === 'pre num') col.preNum = i;
            else if (h === 'today shift') col.shift = i;
            else if (h === 'pre week begin') col.week = i;
            else if (h === 'coaching time') col.coachTime = i;
        }
        if (col.login === undefined || col.submitted === undefined) return -1;

        // v41.21: METRIC ROUTING — the scrape reads whatever TAB is active. On the Positive
        // Reinforcement tab it captures ONLY positive rows; on Associate Coaching it captures
        // Elevate rows. Previously ALL rows were forced into elevateByLogin and it was wiped every
        // scrape, so viewing the Positive tab wiped Elevate (elev dropped to ~29 = positives
        // mislabeled). Fix: (a) skip 'Positive Reinforcement' rows here, (b) only REPLACE
        // elevateByLogin when this scrape actually contains Elevate rows — otherwise keep the
        // last good Elevate data. This makes the tool tab-independent for Elevate.
        var _rows = [];
        for (var _j = 1; _j < lines.length; _j++) {
            if (!lines[_j].trim()) continue;
            var _cc = parseCSVLine(lines[_j]);
            var _lg = (_cc[col.login] || '').trim().toLowerCase();
            var _mt = (_cc[col.metric] || '').trim();
            if (!_lg) continue;
            if (/positive reinforcement/i.test(_mt)) continue;   // route positives out of Elevate
            _rows.push(_cc);
        }
        if (_rows.length === 0) {
            // This scrape had NO Elevate rows (e.g. we're on the Positive tab) — keep prior Elevate.
            console.log('[CoachTracker] parse: 0 Elevate rows in this scrape — keeping prior Elevate data.');
            return Object.keys(elevateByLogin).reduce(function(n,l){ return n + elevateByLogin[l].length; }, 0);
        }
        elevateByLogin = {};
        submittedByLogin = {};
        var count = 0;
        var alreadySubmitted = [];
        for (var jr = 0; jr < _rows.length; jr++) {
            var c = _rows[jr];
            var login = (c[col.login] || '').trim().toLowerCase();
            var submitted = (c[col.submitted] || '').trim();
            if (!login) continue;
            if (!elevateByLogin[login]) elevateByLogin[login] = [];
            var _mtr = (c[col.metric] || '').trim();
            var _wk = (col.week !== undefined ? (c[col.week] || '').trim() : '');
            // v41.17: DEDUP GUARD — never count the same login|metric|week twice (prevents the item
            // count from being inflated by duplicate scrape rows). One coaching per metric per week.
            // v41.44: dedup by METRIC ONLY (ignore week). The week string can vary between scrape
            // passes (blank vs 'Sep 13, 2026'), which let the same coaching slip in twice and inflated
            // the count (~3/AA vs the true ~1.1). One coaching per login|metric on the current list.
            var _dup = elevateByLogin[login].some(function(e){ return e.metric === _mtr; });
            if (_dup) continue;
            elevateByLogin[login].push({
                count: parseInt(c[col.preNum]) || 1,
                date: '',
                type: 'ELEV',
                name: (col.name !== undefined ? (c[col.name] || '').trim() : ''),   // v41.30: carry Full Name (was dropped -> 'name n/a')
                shift: (col.shift !== undefined ? (c[col.shift] || '').trim() : ''),
                week: _wk,
                metric: _mtr,
                formURL: (c[col.form] || '').trim(),
                submittedBy: (col.submitted !== undefined ? (c[col.submitted] || '').trim().toLowerCase() : ''),
                coachTime: (col.coachTime !== undefined ? (c[col.coachTime] || '').trim().slice(0,10) : '')
            });
            count++;
            // v41: if the dashboard shows this row was already Submitted, record it in a HIDE set
            // (login|metric) so it drops off the pending list — but do NOT log a completion. This
            // stops the fake "completed by <zone/leader> at <scrape-time>" records (e.g. 4 AM, 'chilled').
            // v41.20: DO NOT populate submittedByLogin from the scrape. The scraped 'Submitted By'
            // column is unreliable (fuzzy DOM date/leader detection) and marking it here PERSISTS a
            // permanent hide for every submitted row -> hid ALL Elevate (elev:0). Hiding is driven
            // only by real tool ✓ completions now. (submitted var intentionally ignored.)
        }
        submittedByLogin = {};                              // never carry scrape-derived hides
        GM_setValue('elevateSubmittedHide', '{}');          // wipe any previously-persisted pollution
        if (Object.keys(submittedByLogin).length > 0) {
            console.log('[CoachTracker] v41 hiding ' + Object.keys(submittedByLogin).length + ' already-submitted rows (not logged as completions)');
        }
        GM_setValue('elevateData', JSON.stringify(elevateByLogin));
        GM_setValue('elevateTimestamp', Date.now());
        console.log('[CoachTracker] Elevate: ' + count + ' total entries, ' + Object.keys(elevateByLogin).length + ' associates');
        return count;
    }

    // === NEW: Parse Associate Error Details CSV ===
    function parseErrorDetailsCSV(text) {
        var lines = text.replace(/\r/g, '').split('\n');
        if (lines.length < 2) return 0;
        var header = parseCSVLine(lines[0].replace(/^\uFEFF/, ''));
        var col = {};
        for (var i = 0; i < header.length; i++) {
            var h = header[i].toLowerCase().trim();
            if (h === 'associate id') col.login = i;
            else if (h === 'event day') col.eventDay = i;
            else if (h === 'metric name') col.metric = i;
            else if (h === 'order id') col.orderId = i;
            else if (h === 'asin') col.asin = i;
            else if (h === 'item name') col.itemName = i;
            else if (h === 'f3 category group') col.category = i;
            else if (h === 'picklist group id') col.picklistId = i;
            else if (h === 'package id') col.packageId = i;
            else if (h === 'aggregation id') col.aggId = i;
            else if (h === 'location id') col.locationId = i;
            else if (h === 'pick zone') col.pickZone = i;
            else if (h === 'event time') col.eventTime = i;
            else if (h === 'site id') col.siteId = i;
        }
        if (col.login === undefined) return -1;

        coachingErrDetails = {};
        var count = 0;
        for (var j = 1; j < lines.length; j++) {
            if (!lines[j].trim()) continue;
            var c = parseCSVLine(lines[j]);
            var login = (c[col.login] || '').trim().toLowerCase();
            if (!login) continue;
            if (!coachingErrDetails[login]) coachingErrDetails[login] = [];
            coachingErrDetails[login].push({
                eventDay: col.eventDay !== undefined ? (c[col.eventDay] || '').trim() : '',
                metric: col.metric !== undefined ? (c[col.metric] || '').trim() : '',
                orderId: col.orderId !== undefined ? (c[col.orderId] || '').trim() : '',
                asin: col.asin !== undefined ? (c[col.asin] || '').trim() : '',
                itemName: col.itemName !== undefined ? (c[col.itemName] || '').trim() : '',
                category: col.category !== undefined ? (c[col.category] || '').trim() : '',
                picklistId: col.picklistId !== undefined ? (c[col.picklistId] || '').trim() : '',
                packageId: col.packageId !== undefined ? (c[col.packageId] || '').trim() : '',
                aggId: col.aggId !== undefined ? (c[col.aggId] || '').trim() : '',
                locationId: col.locationId !== undefined ? (c[col.locationId] || '').trim() : '',
                pickZone: col.pickZone !== undefined ? (c[col.pickZone] || '').trim() : '',
                eventTime: col.eventTime !== undefined ? (c[col.eventTime] || '').trim() : ''
            });
            count++;
        }
        GM_setValue('coachingErrDetails', JSON.stringify(coachingErrDetails));
        GM_setValue('errDetailsTimestamp', Date.now());
        console.log('[CoachTracker] Error Details: ' + count + ' rows, ' + Object.keys(coachingErrDetails).length + ' associates');
        return count;
    }

    function loadElevateCache() {
        try {
            var d = GM_getValue('elevateData', null);
            if (d) { elevateByLogin = JSON.parse(d); }
        } catch(e) {}
        // Also load error details cache
        try {
            var ed = GM_getValue('coachingErrDetails', null);
            if (ed) { coachingErrDetails = JSON.parse(ed); }
        } catch(e) {}
        // Also load positive coaching cache
        try {
            var pd = GM_getValue('positiveData', null);
            if (pd) { positiveByLogin = JSON.parse(pd); }
        } catch(e) {}
        // Also load cycle time cache
        try {
            var ctd = GM_getValue('cycleTimeData', null);
            if (ctd) { cycleTimeByLogin = JSON.parse(ctd); }
        } catch(e) {}
    }

    // === FIREBASE SYNC FOR ELEVATE DATA ===
    var FIREBASE_DB_URL = 'https://engage-coaching-tracker-default-rtdb.firebaseio.com';
    var ELEVATE_SITE_CODE = GM_getValue('elevate_site_code', '');
    var ELEVATE_SYNC_MS = 10 * 60 * 1000; // v42.3: Sync every 10 minutes (lighter on PCs)

    function getElevateSiteCode() {
        if (ELEVATE_SITE_CODE) return ELEVATE_SITE_CODE;
        var code = prompt('Engage Coaching Tracker\n\nEnter your site code (e.g., UNJ2, UFL6, UGA2):');
        if (code && code.trim().length >= 3) {
            code = code.trim().toUpperCase();
            GM_setValue('elevate_site_code', code);
            ELEVATE_SITE_CODE = code;
            return code;
        }
        return '';
    }

    if (!ELEVATE_SITE_CODE) {
        setTimeout(function() {
            var code = getElevateSiteCode();
            if (code) {
                console.log('[CoachTracker] Site: ' + code + ' | Firebase path: /' + code);
                pullElevateFromFirebase();
            }
        }, 3000);
    } else {
        console.log('[CoachTracker] Site: ' + ELEVATE_SITE_CODE + ' | Firebase path: /' + ELEVATE_SITE_CODE);
    }

    // Firebase REST helper — replaces gistRequest
    function firebaseRequest(path, method, body) {
        return new Promise(function(resolve, reject) {
            var url = FIREBASE_DB_URL + '/' + ELEVATE_SITE_CODE + '/' + path + '.json';
            GM_xmlhttpRequest({
                method: method || 'GET',
                url: url,
                headers: { 'Content-Type': 'application/json' },
                data: body ? JSON.stringify(body) : undefined,
                timeout: 15000,
                onload: function(r) {
                    if (r.status >= 200 && r.status < 300) {
                        try { resolve(JSON.parse(r.responseText)); } catch(e) { resolve(null); }
                    } else {
                        reject(new Error('Firebase ' + r.status));
                    }
                },
                onerror: function() { reject(new Error('Network error')); },
                ontimeout: function() { reject(new Error('Timeout')); }
            });
        });
    }

    // === FIREBASE PUSH/PULL FUNCTIONS ===

    async function pushElevateToFirebase(isNewUpload) {
        try {
            var site = getElevateSiteCode();
            if (!site) { console.warn('[CoachTracker] Firebase push skipped: no site code'); return false; }
            var currentUploadId = GM_getValue('elevateUploadId', '') || Date.now().toString(36);
            var uploadId = isNewUpload ? Date.now().toString(36) : currentUploadId;
            if (isNewUpload) GM_setValue('elevateUploadId', uploadId);
            var payload = { data: elevateByLogin, timestamp: Date.now(), uploadedBy: 'manager', uploadId: uploadId };
            await firebaseRequest('elevate_data', 'PUT', payload);
            console.log('[CoachTracker] Elevate data pushed to Firebase (' + Object.keys(elevateByLogin).length + ' associates)');
            return true;
        } catch(e) { console.error('[CoachTracker] Firebase push error:', e.message); return false; }
    }

    async function pushErrDetailsToFirebase() {
        try {
            var site = getElevateSiteCode();
            if (!site) return false;
            var payload = { data: coachingErrDetails, timestamp: Date.now() };
            await firebaseRequest('errdetails', 'PUT', payload);
            console.log('[CoachTracker] Error details pushed to Firebase (' + Object.keys(coachingErrDetails).length + ' associates)');
            return true;
        } catch(e) { console.error('[CoachTracker] Error details Firebase push error:', e.message); return false; }
    }

    // === SHARED COACHING LOG ===
    var coachingLog = []; // Array of { login, metric, completedBy, timestamp, action }

    async function pushCoachingLogToFirebase(skipMerge) {
        try {
            var site = getElevateSiteCode();
            if (!site) return false;

            // Pull latest log from Firebase first and merge to avoid overwriting other users' entries
            if (!skipMerge) {
                try {
                    var remotePayload = await firebaseRequest('coaching_log', 'GET');
                    if (remotePayload && remotePayload.log) {
                        // Check if remote has a newer resetId — if so, honor the reset first
                        var localResetId = GM_getValue('coachingLogResetId', '');
                        if (remotePayload.resetId && remotePayload.resetId !== localResetId) {
                            coachingLog = remotePayload.log || [];
                            GM_setValue('coachingLog', JSON.stringify(coachingLog));
                            GM_setValue('coachingLogResetId', remotePayload.resetId);
                            buildCompletedFromLog();
                            console.log('[CoachTracker] Reset detected before push (resetId: ' + remotePayload.resetId + ')');
                        } else if (remotePayload.log.length > 0) {
                            // Merge: add any remote entries we don't have locally
                            var localKeys = {};
                            coachingLog.forEach(function(e) {
                                localKeys[e.timestamp + '|' + e.login + '|' + e.metric + '|' + e.action] = true;
                            });
                            var added = 0;
                            remotePayload.log.forEach(function(remoteEntry) {
                                var rKey = remoteEntry.timestamp + '|' + remoteEntry.login + '|' + remoteEntry.metric + '|' + remoteEntry.action;
                                if (!localKeys[rKey]) {
                                    coachingLog.push(remoteEntry);
                                    added++;
                                }
                            });
                            if (added > 0) {
                                coachingLog.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
                                GM_setValue('coachingLog', JSON.stringify(coachingLog));
                                buildCompletedFromLog();
                                console.log('[CoachTracker] Merged ' + added + ' remote log entries before push');
                            }
                        }
                    }
                } catch(mergeErr) {
                    console.warn('[CoachTracker] Log merge before push failed:', mergeErr.message);
                }
            }

            // Push merged log to Firebase
            var currentResetId = GM_getValue('coachingLogResetId', '');
            await firebaseRequest('coaching_log', 'PUT', { log: coachingLog, timestamp: Date.now(), resetId: currentResetId });
            GM_setValue('coachingLog', JSON.stringify(coachingLog));
            console.log('[CoachTracker] Coaching log pushed to Firebase (' + coachingLog.length + ' entries)');
            return true;
        } catch(e) { console.error('[CoachTracker] Coaching log push error:', e.message); return false; }
    }

    async function pullCoachingLogFromFirebase() {
        try {
            var payload = await firebaseRequest('coaching_log', 'GET');
            if (payload && payload.log) {
                // Check for reset using explicit resetId
                var localResetId = GM_getValue('coachingLogResetId', '');
                if (payload.resetId && payload.resetId !== localResetId) {
                    // A genuine reset happened — replace local with remote
                    coachingLog = payload.log;
                    GM_setValue('coachingLog', JSON.stringify(coachingLog));
                    GM_setValue('coachingLogResetId', payload.resetId);
                    buildCompletedFromLog();
                    console.log('[CoachTracker] Pulled coaching log from Firebase (reset detected, resetId: ' + payload.resetId + ', now ' + coachingLog.length + ' entries)');
                    if (engageEmployees.length > 0 && dataLoaded) matchAndAlert();
                } else {
                    // Merge — union of local and remote entries
                    var localKeys = {};
                    coachingLog.forEach(function(e) {
                        localKeys[e.timestamp + '|' + e.login + '|' + e.metric + '|' + e.action] = true;
                    });
                    var added = 0;
                    payload.log.forEach(function(remoteEntry) {
                        var rKey = remoteEntry.timestamp + '|' + remoteEntry.login + '|' + remoteEntry.metric + '|' + remoteEntry.action;
                        if (!localKeys[rKey]) {
                            coachingLog.push(remoteEntry);
                            added++;
                        }
                    });
                    if (added > 0) {
                        coachingLog.sort(function(a, b) { return (a.timestamp || 0) - (b.timestamp || 0); });
                    }
                    GM_setValue('coachingLog', JSON.stringify(coachingLog));
                    buildCompletedFromLog();
                    console.log('[CoachTracker] Pulled coaching log from Firebase (' + coachingLog.length + ' entries, +' + added + ' new)');
                    if (added > 0 && engageEmployees.length > 0 && dataLoaded) matchAndAlert();
                }
            }
            return true;
        } catch(e) { console.error('[CoachTracker] Coaching log pull error:', e.message); return false; }
    }

    function loadCoachingLogCache() {
        try {
            var cached = GM_getValue('coachingLog', null);
            if (cached) {
                coachingLog = JSON.parse(cached);
                // v39.2: ONE-TIME CLEAN RESET. The old log accumulated weeks of history + test data
                // with no week scoping (327+ entries, 1422% progress). Archive it once, then start fresh
                // with week-scoped completions. Guarded so it runs a single time.
                if (!GM_getValue('clean_reset_v39_3', false)) {
                    try { GM_setValue('coachingLog_archive_v39_3', JSON.stringify(coachingLog)); } catch(e) {}
                    var archivedCount = coachingLog.length;
                    coachingLog = [];
                    GM_setValue('coachingLog', JSON.stringify(coachingLog));
                    GM_setValue('elevateCompleted', '{}');
                    // v39.3 FIX: the old wipe only cleared LOCAL — then pullCoachingLogFromFirebase
                    // re-imported the 439 stale entries from Firebase. We must clear FIREBASE too,
                    // with a NEW resetId so every client (including this one) adopts the empty log
                    // instead of merging the old entries back.
                    var freshResetId = 'reset_' + Date.now();
                    GM_setValue('coachingLogResetId', freshResetId);
                    try {
                        // Archive the old shared log to Firebase, then overwrite with an empty, reset-stamped log.
                        firebaseRequest('archives/coaching_log_pre_v39_3', 'PUT', { log: coachingLog, archivedAt: Date.now() }).catch(function(){});
                        firebaseRequest('coaching_log', 'PUT', { log: [], timestamp: Date.now(), resetId: freshResetId }).then(function(){
                            console.log('[CoachTracker] v39.3 CLEAN RESET — Firebase coaching_log wiped (resetId ' + freshResetId + ')');
                        }).catch(function(e){ console.warn('[CoachTracker] v39.3 Firebase wipe failed: ' + (e && e.message)); });
                    } catch(e) {}
                    GM_setValue('clean_reset_v39_3', true);
                    console.log('[CoachTracker] v39.3 CLEAN RESET — archived ' + archivedCount + ' local entries + wiping Firebase');
                }
                buildCompletedFromLog();
            }
        } catch(e) {}
    }

    function addToCoachingLog(login, metric, completedBy, action, week) {
        coachingLog.push({ login: login, metric: metric, week: (week || currentCoachingWeek || ''), completedBy: completedBy, timestamp: Date.now(), action: action || 'completed' });
        GM_setValue('coachingLog', JSON.stringify(coachingLog));
        // Rebuild the completed cache from the log (single source of truth)
        buildCompletedFromLog();
        pushCoachingLogToFirebase();
    }

    async function pullElevateFromFirebase() {
        try {
            var payload = await firebaseRequest('elevate_data', 'GET');
            if (payload && payload.data && payload.timestamp) {
                var localUploadId = GM_getValue('elevateUploadId', '');
                if (payload.uploadId && payload.uploadId !== localUploadId) {
                    GM_setValue('elevateUploadId', payload.uploadId);
                    console.log('[CoachTracker] New uploadId detected: ' + payload.uploadId);
                }
                elevateByLogin = payload.data;
                GM_setValue('elevateData', JSON.stringify(elevateByLogin));
                GM_setValue('elevateTimestamp', payload.timestamp);
                console.log('[CoachTracker] Pulled Elevate from Firebase (' + Object.keys(elevateByLogin).length + ' associates)');
                if (engageEmployees.length > 0) matchAndAlert();
            }
            // Also pull error details
            var errPayload = await firebaseRequest('errdetails', 'GET');
            if (errPayload && errPayload.data) {
                coachingErrDetails = errPayload.data;
                GM_setValue('coachingErrDetails', JSON.stringify(coachingErrDetails));
                GM_setValue('errDetailsTimestamp', errPayload.timestamp || Date.now());
                console.log('[CoachTracker] Pulled Error Details from Firebase (' + Object.keys(coachingErrDetails).length + ' associates)');
            }
            // Also pull positive coaching data
            var posPayload = await firebaseRequest('positive_coachings', 'GET');
            if (posPayload && posPayload.data) {
                positiveByLogin = posPayload.data;
                GM_setValue('positiveData', JSON.stringify(positiveByLogin));
                GM_setValue('positiveTimestamp', posPayload.timestamp || Date.now());
                console.log('[CoachTracker] Pulled Positive Coachings from Firebase (' + Object.keys(positiveByLogin).length + ' associates)');
            }
            // Also pull cycle time data
            var ctPayload = await firebaseRequest('cycle_time_data', 'GET');
            if (ctPayload && ctPayload.data) {
                cycleTimeByLogin = ctPayload.data;
                GM_setValue('cycleTimeData', JSON.stringify(cycleTimeByLogin));
                console.log('[CoachTracker] Pulled Cycle Time from Firebase (' + Object.keys(cycleTimeByLogin).length + ' associates)');
            }
            return true;
        } catch(e) { console.error('[CoachTracker] Firebase pull error:', e.message); return false; }
    }

    // === ENGAGE API ===


    // For /engage/team/engage pages that load manager data dynamically,
    // intercept the GraphQL responses to extract employee data directly


    function fetchEngageData(skip, allHits) {
        skip = skip || 0; allHits = allHits || [];
        if (managerLogins.length === 0) return;
        var managerList = managerLogins.map(function(m) { return '\\"' + m + '\\"'; }).join(',');
        var query = {
            operationName: "fetchTeamTableData",
            variables: { withBehindTheSmile: false },
            query: 'query fetchTeamTableData($withBehindTheSmile: Boolean) { employeesWithRecommendationsBySubject( input: {take: 100, skip: ' + skip + ', filters: [{type: EMPLOYEE, key: "managerLogin", operator: IN, value: "[' + managerList + ']"}, {type: EMPLOYEE, key: "isManager", operator: EQ, value: "false"}, {type: METRIC, key: "onPremise", operator: NON_NULLISH}], sorts: [{type: METRIC, key: "lastEngaged", dataKey: "engagementTime", direction: DESC_NULLISH_LAST}], withBehindTheSmile: $withBehindTheSmile} ) { total hits { employeeId login firstName lastName fullName managerLogin shiftPattern employeeSite metrics { metricId data __typename } __typename } __typename } }'
        };
        fetch(GRAPHQL_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(query) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            var result = data && data.data && data.data.employeesWithRecommendationsBySubject;
            if (!result) return;
            allHits = allHits.concat(result.hits || []);
            pageCount++;
            if (allHits.length < (result.total || 0)) fetchEngageData(allHits.length, allHits);
            else {
                engageEmployees = allHits;
                dataLoaded = true;                 // v39: ensure downstream render is unblocked
                console.log('[CoachTracker] ' + engageEmployees.length + ' on-premise employees loaded');
                matchAndAlert();                   // v39: ALWAYS re-render once the roster lands (was gated on dataLoaded, which could be false -> panel stuck on "Loading")
            }
        }).catch(function(err) {
            console.error('[CoachTracker] API error:', err);
            // v39: retry once after 3s in case the SPA/auth wasn't ready on first load
            if (!fetchEngageData.__retried) { fetchEngageData.__retried = true; setTimeout(function(){ fetchEngageData(); }, 3000); }
        });
    }


    function parseData(text) {
        var lines = text.trim().split('\n');
        trackedByEmpId = {}; trackedByLogin = {};
        for (var i = 0; i < lines.length; i++) {
            var parts = lines[i].replace(/\r/g, '').split(',');
            var key = (parts[0] || '').trim();
            if (!key) continue;
            var entry = { count: parseInt(parts[1]) || 0, date: (parts[2] || '').trim(), type: (parts[3] || 'MEAL').trim().toUpperCase() };
            if (key.indexOf('login:') === 0) {
                var login = key.substring(6).toLowerCase().trim();
                if (!trackedByLogin[login]) trackedByLogin[login] = [];
                trackedByLogin[login].push(entry);
            } else if (key.length >= 6) {
                if (!trackedByEmpId[key]) trackedByEmpId[key] = [];
                trackedByEmpId[key].push(entry);
            }
        }
        dataLoaded = true;
    }

    function loadCache() {
        var cached = GM_getValue('ctCache', null);
        if (cached) { parseData(cached); dataLoaded = true; }
    }

    function getTypeConfig(type) { return TYPE_CONFIG[type] || DEFAULT_TYPE; }

    // === MATCHING ===
    function matchAndAlert() {
        // v39: ON-SITE now comes from Find People (onSiteLogins), NOT Engage. We iterate over all
        // logins that have a coaching (Elevate or Positive) and keep only those currently on site.
        currentMatches = [];
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));

        // Union of all logins that have any coaching.
        var coachingLogins = {};
        Object.keys(elevateByLogin || {}).forEach(function(l){ coachingLogins[l] = true; });
        Object.keys(positiveByLogin || {}).forEach(function(l){ coachingLogins[l] = true; });

        Object.keys(coachingLogins).forEach(function(login) {
            // ON-SITE GATE: only include associates currently clocked in per Find People.
            // If the roster hasn't loaded yet (onSiteCount 0), show nothing (avoids false matches).
            if (!onSiteLogins[login]) return;

            var alerts = [];
            var displayName = '';

            if (elevateByLogin[login]) {
                elevateByLogin[login].forEach(function(alert) {
                    if (alert.name && !displayName) displayName = alert.name;
                    var key = ckey(login, alert.metric);
                    var subHide = submittedByLogin[login + '|' + (alert.metric || '')];
                    // v41.24: SAME-DAY dashboard-completion hide, now SAFE (precise offset capture).
                    // Hide a coaching only when BOTH are true: Submitted By is filled AND Coaching Time
                    // == TODAY. This catches AAs completed on the QuickSight page WITHOUT the tool
                    // (prevents double-coaching). Strictly same-day: a completion dated any other day
                    // does NOT hide it (daily reset). Empty/ambiguous data never hides (Elevate-safe).
                    var dashDoneToday = !!alert.submittedBy && !!alert.coachTime && alert.coachTime === todayKey();
                    if (!completed[key] && !subHide && !dashDoneToday) alerts.push(alert);
                });
            }
            if (positiveByLogin[login]) {
                positiveByLogin[login].forEach(function(posEntry) {
                    var posMetric = posEntry.metricName || 'Positive Reinforcement';
                    if (posEntry.fullName && !displayName) displayName = posEntry.fullName;
                    var key = ckey(login, posMetric);
                    var subHideP = submittedByLogin[login + '|' + posMetric];
                    if (!completed[key] && !subHideP) {
                        var posFormURL = posEntry.formURL || ('https://formulate.gsf.a2z.com/forms/36f6eb5c-1c4d-4b81-a08e-6d3f8130d8d0?48b591a8-fcb6-4d5b-b7bf-9b5707391a24=' + login);
                        alerts.push({
                            count: 1, date: posEntry.lastCoachingDate || '', type: 'POS', metric: posMetric,
                            formURL: posFormURL, shift: posEntry.shift || '', fullName: posEntry.fullName || ''
                        });
                    }
                });
            }

            if (alerts.length > 0) {
                var visAlerts = hiddenTypes.length > 0 ? alerts.filter(function(a) { return hiddenTypes.indexOf(a.type) < 0; }) : alerts;
                if (visAlerts.length > 0) {
                    currentMatches.push({
                        empId: login, login: login,
                        name: displayName || login,
                        manager: '', site: ELEVATE_SITE_CODE || '', shift: (visAlerts[0] && visAlerts[0].shift) || '',
                        alerts: visAlerts,
                        hasErrDetails: false
                    });
                }
            }
        });

        currentMatches.sort(function(a, b) {
            var aTotal = a.alerts.reduce(function(s, x) { return s + (x.count||1); }, 0);
            var bTotal = b.alerts.reduce(function(s, x) { return s + (x.count||1); }, 0);
            return bTotal - aTotal;
        });
        console.log('[CoachTracker] ' + currentMatches.length + ' on-site associates with pending coachings (of ' + onSiteCount + ' on site)');
        updatePanel();
        updateButton();
    }
    // === STYLES ===
    var styles = document.createElement('style');
    styles.textContent = [
        /* v39 sharpened launcher pill */
        '#mm-btn.ct-launch { position: fixed; bottom: 22px; right: 22px; z-index: 99999; display: inline-flex; align-items: center; gap: 9px; background: linear-gradient(135deg, #14395e 0%, #0d2540 100%); color: #fff; border: 1px solid rgba(255,255,255,0.10); border-radius: 999px; padding: 9px 16px 9px 13px; font-size: 13px; font-weight: 700; letter-spacing: 0.3px; cursor: pointer; box-shadow: 0 8px 22px rgba(11,30,54,0.42), inset 0 1px 0 rgba(255,255,255,0.08); transition: transform 0.14s cubic-bezier(.2,.7,.3,1), box-shadow 0.14s ease, background 0.2s ease; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; -webkit-font-smoothing: antialiased; }',
        '#mm-btn.ct-launch:hover { transform: translateY(-2px) scale(1.02); box-shadow: 0 12px 30px rgba(11,30,54,0.5), inset 0 1px 0 rgba(255,255,255,0.12); }',
        '#mm-btn.ct-launch:active { transform: translateY(0) scale(0.99); }',
        '#mm-btn .ct-launch-ico { font-size: 15px; line-height: 1; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.25)); }',
        '#mm-btn .ct-launch-txt { font-size: 13px; font-weight: 750; }',
        '#mm-btn .ct-launch-badge { min-width: 21px; height: 21px; padding: 0 7px; display: inline-flex; align-items: center; justify-content: center; background: linear-gradient(135deg,#ffb52e,#ff9900); color: #0d2540; border-radius: 999px; font-size: 12px; font-weight: 800; box-shadow: 0 1px 3px rgba(0,0,0,0.25), inset 0 0 0 1px rgba(255,255,255,0.3); }',
        '#mm-btn.ct-launch.has-pending { background: linear-gradient(135deg, #14395e 0%, #0d2540 100%); }',
        '#mm-btn.ct-launch.has-pending .ct-launch-badge { background: linear-gradient(135deg,#ffb52e,#ff9900); color: #0d2540; }',
        '#mm-btn.ct-launch.ok { background: #1f5c3a; box-shadow: 0 6px 20px rgba(31,92,58,0.35); }',
        '#mm-btn.ct-launch.ok .ct-launch-badge { display: none; }',
        '#mm-btn.ct-launch.loading { background: #5b6b7b; box-shadow: 0 6px 20px rgba(91,107,123,0.3); }',
        '#mm-btn.ct-launch.loading .ct-launch-badge { display: none; }',
        '@keyframes mm-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }',
        '#mm-btn.loading .mm-loader { display: inline-block; width: 12px; height: 12px; border: 2px solid #fff; border-top-color: transparent; border-radius: 50%; animation: mm-spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }',
        '.mm-badge { display: inline-block; color: white; padding: 2px 8px; border-radius: 10px; font-size: 10px; font-weight: 700; margin-right: 4px; margin-top: 2px; white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }',
        '.mm-row { background: #FFF0F0 !important; border-left: 4px solid #FF4444 !important; }',
        '#mm-panel { position: fixed; bottom: 80px; right: 20px; z-index: 100001; background: #fff; color: #333; border: 1px solid #e2e8f0; border-radius: 16px; padding: 0; width: 480px; max-height: min(600px, calc(100vh - 100px)); overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.15); display: none; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }',
        '#mm-panel.visible { display: flex; flex-direction: column; }',
        '#mm-panel.ct-size-lg { width: 640px; max-height: min(760px, calc(100vh - 60px)); }',
        '#mm-panel.ct-size-xl { width: 820px; max-height: min(880px, calc(100vh - 40px)); }',
        '#mm-panel h3 { margin: 0; font-size: 15px; color: #1e293b; font-weight: 700; }',
        '#mm-panel .mm-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; border-radius: 16px 16px 0 0; cursor: grab; user-select: none; }',
        '#mm-panel .mm-header:active { cursor: grabbing; }',
        '#mm-panel .mm-close { background: none; border: none; font-size: 18px; cursor: pointer; color: #94a3b8; padding: 4px 8px; border-radius: 6px; transition: all 0.15s; }',
        '#mm-panel .mm-close:hover { background: #f1f5f9; color: #475569; }',
        '#mm-panel .mm-body { overflow-y: auto; overflow-x: hidden; flex: 1 1 auto; min-height: 0; padding: 0; -webkit-overflow-scrolling: touch; }',
        '#mm-panel .mm-list { padding: 8px 14px 14px; }',
        '#mm-panel .mm-item { padding: 12px; margin-bottom: 8px; background: #f8fafc; border-radius: 10px; border: 1px solid #e2e8f0; transition: border-color 0.15s; }',
        '#mm-panel .mm-item:hover { border-color: #cbd5e1; }',
        '#mm-panel .mm-item:last-child { margin-bottom: 0; }',
        '#mm-panel .mm-item-name { font-weight: 700; color: #1e293b; font-size: 14px; }',
        '#mm-panel .mm-item-detail { font-size: 11px; color: #475569; margin-top: 4px; font-weight: 600; }',
        '#mm-panel .mm-item-alerts { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }',
        '#mm-panel .mm-summary { background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 12px 16px; margin: 12px 14px; font-size: 13px; color: #991b1b; font-weight: 600; }',
        '#mm-panel .mm-allclear { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 14px 16px; margin: 12px 14px; font-size: 13px; color: #166534; }',
        '#mm-panel .mm-type-pill { padding: 4px 12px; border-radius: 20px; color: white; font-size: 11px; font-weight: 700; display: inline-block; cursor: pointer; opacity: 1; transition: opacity 0.2s; border: 2px solid transparent; }',
        '#mm-panel .mm-type-pill.inactive { opacity: 0.35; }',
        '#mm-panel .mm-type-pill.active-filter { border-color: #1e293b; }',
        '#mm-panel .mm-filter-bar { padding: 8px 14px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }',
        '#mm-panel .mm-filter-label { font-size: 10px; font-weight: 700; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.5px; margin-right: 4px; }',
        '.mm-elevate-upload { margin: 10px 14px; padding: 12px; background: #f8fafc; border-radius: 10px; border: 1px dashed #cbd5e1; text-align: center; cursor: pointer; font-size: 12px; color: #64748b; transition: all 0.2s; }',
        '.mm-elevate-upload:hover { background: #f1f5f9; border-color: #94a3b8; }',
        '.mm-elevate-upload.loaded { background: #f0fdf4; border-color: #16a34a; color: #166534; }',
        '.mm-elevate-link { display: inline-block; font-size: 11px; color: #dc2626; text-decoration: underline; cursor: pointer; margin-left: 4px; }',
        // NEW: Error details popup styles
        '#mm-err-popup { position: fixed; z-index: 100000; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; box-shadow: 0 20px 60px rgba(0,0,0,0.25); max-width: 1200px; min-width: 1100px; max-height: 500px; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif; }',
        '#mm-err-popup .err-header { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; background: #232F3E; color: #FF9900; font-weight: 700; font-size: 13px; border-radius: 12px 12px 0 0; cursor: grab; user-select: none; }',
        '#mm-err-popup .err-header:active { cursor: grabbing; }',
        '#mm-err-popup .err-close { background: none; border: none; color: #94a3b8; font-size: 18px; cursor: pointer; padding: 2px 6px; }',
        '#mm-err-popup .err-close:hover { color: #fff; }',
        '#mm-err-popup .err-body { overflow-y: auto; max-height: 430px; padding: 12px; }',
        '#mm-err-popup .err-table { width: 100%; border-collapse: collapse; font-size: 11px; }',
        '#mm-err-popup .err-table th { background: #f1f5f9; color: #475569; font-weight: 700; padding: 6px 8px; text-align: left; border-bottom: 2px solid #e2e8f0; position: sticky; top: 0; white-space: nowrap; cursor: pointer; }',
        '#mm-err-popup .err-table th:hover { background: #e2e8f0; color: #1e293b; }',
        '#mm-err-popup .err-table td { padding: 5px 8px; border-bottom: 1px solid #f1f5f9; color: #334155; }',
        '#mm-err-popup .err-table tr:hover td { background: #fef2f2; }',
        '#mm-err-popup .err-empty { padding: 20px; text-align: center; color: #94a3b8; font-size: 13px; }',
        '#mm-err-popup .err-count { font-size: 11px; color: #94a3b8; font-weight: 400; margin-left: 8px; }',
        '.mm-err-btn { display: inline-block; font-size: 10px; color: #fff; background: #232F3E; padding: 2px 8px; border-radius: 8px; cursor: pointer; margin-left: 4px; font-weight: 600; transition: background 0.15s; }',
        '.mm-err-btn:hover { background: #FF9900; }',
        '.mm-uncomplete-btn:hover { background: #b91c1c !important; }',
        /* v37 dashboard (clickable filters) */
        '#ct-dashboard { position:sticky; top:0; z-index:5; background:#fff; margin:0; padding:10px 14px 8px; border-bottom:1px solid #eef1f4; }',
        '.ct-tiles { display:flex; gap:8px; margin-bottom:8px; }',
        '.ct-tile { flex:1; border:none; border-radius:12px; padding:10px 6px; color:#fff; text-align:center; cursor:pointer; font-family:inherit; box-shadow:0 2px 6px rgba(15,45,74,0.12); transition:transform .12s ease, box-shadow .12s ease, filter .12s ease; }',
        '.ct-tile:hover { transform:translateY(-2px); box-shadow:0 6px 16px rgba(15,45,74,0.22); filter:brightness(1.08); }',
        '.ct-tile:active { transform:translateY(0); }',
        '.ct-tile-active { outline:3px solid #ff9900; outline-offset:1px; filter:brightness(1.1); }',
        '.ct-tile-n { font-size:22px; font-weight:800; line-height:1; }',
        '.ct-tile-l { font-size:9.5px; font-weight:700; opacity:0.92; margin-top:3px; letter-spacing:0.2px; }',
        '.ct-tile-sub { font-size:8px; font-weight:600; opacity:0.72; margin-top:1px; letter-spacing:0.2px; }',
        '.mm-compact { display:flex; align-items:center; justify-content:space-between; padding:7px 10px; cursor:pointer; border-radius:8px; }',
        '.mm-compact:hover { background:#f1f5f9; }',
        '.mm-compact .lg { font-family:ui-monospace,Menlo,monospace; font-size:12px; font-weight:700; color:#1e293b; }',
        '.mm-compact .rt { display:flex; align-items:center; gap:6px; }',
        '.mm-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }',
        '.mm-cnt { font-size:10px; font-weight:700; color:#64748b; background:#e2e8f0; border-radius:10px; padding:1px 7px; }',
        '.mm-chev { font-size:10px; color:#94a3b8; }',
        '.ct-prog-wrap { margin:4px 0 8px; }',
        '.ct-prog-label { font-size:10px; font-weight:700; color:#475569; margin-bottom:3px; }',
        '.ct-prog-track { height:8px; background:#e6e8eb; border-radius:6px; overflow:hidden; }',
        '.ct-prog-fill { height:100%; background:linear-gradient(90deg,#16a34a,#22c55e); border-radius:6px; transition:width .3s; }',
        '.ct-break { margin:6px 0 2px; }',
        '.ct-break-h { font-size:9px; font-weight:700; color:#94a3b8; text-transform:uppercase; letter-spacing:0.3px; margin-bottom:4px; }',
        '.ct-break-row { display:flex; flex-wrap:wrap; gap:5px; }',
        '.ct-pill { font-size:10px; font-weight:600; color:#fff; padding:3px 9px; border:none; border-radius:999px; cursor:pointer; font-family:inherit; transition:transform .1s ease, filter .1s ease; }',
        '.ct-pill:hover { transform:translateY(-1px); filter:brightness(1.1); }',
        '.ct-pill-metric { background:#334155; }',
        '.ct-pill-active { outline:2px solid #ff9900; outline-offset:1px; }',
        '.ct-activefilter { margin-top:8px; font-size:10.5px; color:#475569; display:flex; align-items:center; gap:8px; }',
        '.ct-clearfilter { background:#eef1f4; border:none; border-radius:999px; padding:2px 9px; font-size:10px; font-weight:700; color:#334155; cursor:pointer; }',
        '.ct-clearfilter:hover { background:#e0e5ea; }',
        /* v37 claim indicator */
        '.ct-claim { display:inline-block; font-size:9px; font-weight:700; color:#7c2d12; background:#fde68a; border:1px solid #f59e0b; padding:1px 6px; border-radius:8px; margin-left:6px; }',
        '.ct-claim-mine { color:#065f46; background:#a7f3d0; border-color:#10b981; }',
        /* v37 minimize */
        '#mm-panel.minimized .mm-body { display:none !important; }',
        '#mm-panel.minimized { max-height:none; height:auto; }',
        '.mm-min { background:none; border:none; color:#fff; font-size:18px; line-height:1; cursor:pointer; padding:0 6px; }'
        ,
        /* v38 flat header icons + instant CSS tooltips (MegaHelm style) */
        '.mm-ico { background:none; border:none; color:#475569; opacity:0.82; font-size:15px; line-height:1; cursor:pointer; padding:2px 6px; border-radius:6px; position:relative; transition:opacity .12s ease, background .12s ease; }',
        '.mm-ico:hover { opacity:1; background:rgba(15,23,42,0.08); }',
        '.mm-ico[data-tip]:hover::after { content:attr(data-tip); position:absolute; top:120%; right:0; white-space:nowrap; background:#0f2d4a; color:#fff; font-size:10px; font-weight:600; padding:3px 7px; border-radius:5px; z-index:20; box-shadow:0 2px 8px rgba(0,0,0,0.25); }',
        '.mm-more-menu { position:absolute; top:120%; right:0; background:#fff; border:1px solid #e2e8f0; border-radius:10px; box-shadow:0 8px 24px rgba(0,0,0,0.18); padding:6px; z-index:30; min-width:220px; }',
        '.mm-more-item { display:block; width:100%; text-align:left; background:none; border:none; padding:8px 10px; font-size:12px; font-weight:600; color:#b91c1c; border-radius:6px; cursor:pointer; font-family:inherit; }',
        '.mm-more-item:hover { background:#fef2f2; }',
        /* v38 lean status line */
        '.ct-status { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 14px; font-size:10.5px; color:#64748b; border-bottom:1px solid #f1f5f9; }',
        '.ct-status b { color:#1e293b; }',
        '.ct-link { color:#0284c7; cursor:pointer; font-weight:600; }',
        '.ct-link:hover { text-decoration:underline; }',
        '.ct-synced { color:#16a34a; font-weight:600; }',
        '.ct-loading { padding:16px 14px; font-size:12px; color:#64748b; text-align:center; }',
        /* v38 two-layer mark-all modal */
        '.mm-modal-overlay { position:fixed; inset:0; background:rgba(15,23,42,0.45); z-index:1000001; display:flex; align-items:center; justify-content:center; }',
        '.mm-modal { background:#fff; border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,0.35); width:340px; max-width:90vw; padding:18px; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif; }',
        '.mm-modal-h { font-size:15px; font-weight:800; color:#0f2d4a; margin-bottom:6px; }',
        '.mm-modal-sub { font-size:12px; color:#475569; margin-bottom:12px; line-height:1.4; }',
        '.mm-scope-list { display:flex; flex-direction:column; gap:6px; max-height:260px; overflow-y:auto; }',
        '.mm-scope-btn { text-align:left; background:#f1f5f9; border:1px solid #e2e8f0; border-radius:8px; padding:9px 12px; font-size:12px; font-weight:600; color:#1e293b; cursor:pointer; font-family:inherit; transition:background .12s ease; }',
        '.mm-scope-btn:hover { background:#e0e7ff; border-color:#c7d2fe; }',
        '.mm-scope-btn b { float:right; color:#7c2d2d; }',
        '.mm-modal-foot { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }',
        '.mm-modal-cancel { background:#eef1f4; border:none; border-radius:8px; padding:8px 14px; font-size:12px; font-weight:700; color:#334155; cursor:pointer; font-family:inherit; }',
        '.mm-modal-go { background:#dc2626; border:none; border-radius:8px; padding:8px 14px; font-size:12px; font-weight:800; color:#fff; cursor:pointer; font-family:inherit; }',
        '.mm-modal-go:hover { background:#b91c1c; }',
        /* v38 team summary + neutral menu item */
        '.mm-more-item-neutral { color:#1e293b !important; }',
        '.mm-more-item-neutral:hover { background:#eef2ff !important; }',
        '.mm-sum-table { width:100%; border-collapse:collapse; font-size:12px; margin-top:4px; }',
        '.mm-sum-table th { text-align:left; padding:6px 8px; background:#f1f5f9; color:#475569; font-weight:700; font-size:10px; }',
        '.mm-sum-table td { padding:6px 8px; border-bottom:1px solid #f1f5f9; color:#1e293b; }',
        /* v39 dropdown sections */
        '.ct-drops { display:flex; flex-wrap:wrap; gap:6px; padding:6px 14px; border-bottom:1px solid #f1f5f9; }',
        '.ct-drop-chip { background:#f1f5f9; border:1px solid #e2e8f0; border-radius:999px; padding:3px 10px; font-size:10px; font-weight:700; color:#334155; cursor:pointer; font-family:inherit; }',
        '.ct-drop-chip:hover { background:#e0e7ff; }',
        '.ct-drop-panel { margin:0 14px 8px; max-height:260px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px; }',
        '.ct-drop-empty { padding:12px; font-size:11px; color:#94a3b8; text-align:center; }',
        '.ct-drop-table { width:100%; border-collapse:collapse; font-size:10px; }',
        '.ct-drop-table th { position:sticky; top:0; background:#f1f5f9; text-align:left; padding:5px 8px; font-weight:700; color:#475569; }',
        '.ct-drop-table td { padding:5px 8px; border-bottom:1px solid #f1f5f9; color:#1e293b; }',
        '.ct-hide-row { display:flex; gap:8px; padding:10px; }',
        '.ct-hide-toggle { color:#fff; font-size:10px; font-weight:700; padding:4px 12px; border-radius:999px; cursor:pointer; }',
        '.ct-undo-btn { background:#fee2e2; color:#b91c1c; border:none; border-radius:6px; padding:2px 8px; font-size:9px; font-weight:700; cursor:pointer; font-family:inherit; }',
        '.ct-undo-btn:hover { background:#fecaca; }'
    ].join(' ');
    document.head.appendChild(styles);

    // === Error Details Popup with Completion Tracking ===
    function showErrDetailsPopup(login, name, anchorEl) {
        closeErrDetailsPopup();
        var details = coachingErrDetails[login] || [];
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var popup = document.createElement('div'); popup.id = 'mm-err-popup';

        var completedMetrics = {};
        for (var ck in completed) { if (ck.indexOf(login + '|') === 0) completedMetrics[ck.substring(login.length + 1)] = completed[ck]; }
        var doneCount = 0, pendingCount = 0;
        for (var di = 0; di < details.length; di++) { if (completedMetrics[details[di].metric]) doneCount++; else pendingCount++; }

        var popupErrCount = details.length;
        var ctData = cycleTimeByLogin[login];
        if (ctData && ctData.length > 0) popupErrCount += 1;

        var headerHtml = '<div class="err-header"><span>\uD83D\uDCCB ' + (name || login) + ' <span style="color:#94a3b8;font-weight:400;font-size:11px;">(' + login + ')</span> \u2014 Error Details<span class="err-count">' + popupErrCount + ' error' + (popupErrCount !== 1 ? 's' : '') + (doneCount > 0 ? ' \u2022 ' + doneCount + ' coached' : '') + '</span></span><button class="err-close" id="mm-err-close">&times;</button></div>';
        var bodyHtml = '<div class="err-body">';
        if (details.length === 0) {
            bodyHtml += '<div class="err-empty">No error details available.<br><span style="font-size:11px;color:#92400e;">Open the QuickSight Elevate dashboard and run the Elevate Error Scraper to pull this data.</span></div>';
        } else {
            var metricSummary = {};
            details.forEach(function(d) { if (!metricSummary[d.metric]) metricSummary[d.metric] = { total: 0, done: !!completedMetrics[d.metric] }; metricSummary[d.metric].total++; });

            bodyHtml += '<div style="padding:8px 4px 4px;display:flex;gap:4px;flex-wrap:wrap;align-items:center;"><span class="err-filter-pill err-filter-active" data-metric="ALL" style="display:inline-block;font-size:9px;padding:2px 8px;border-radius:8px;font-weight:700;background:#232F3E;color:#FF9900;cursor:pointer;">All (' + details.length + ')</span>';
            for (var ms in metricSummary) { bodyHtml += '<span class="err-filter-pill" data-metric="' + ms + '" style="display:inline-block;font-size:9px;padding:2px 8px;border-radius:8px;font-weight:700;cursor:pointer;' + (metricSummary[ms].done ? 'background:#dcfce7;color:#166534;' : 'background:#fef2f2;color:#991b1b;') + '">' + (metricSummary[ms].done ? '\u2705 ' : '\u23F3 ') + ms + ' (' + metricSummary[ms].total + ')</span>'; }
            bodyHtml += '</div>';

            // Errors table
            if (details.length > 0) {
                bodyHtml += '<table class="err-table"><thead><tr><th data-sort="eventDay" style="cursor:pointer;">Date \u2195</th><th data-sort="metric" style="cursor:pointer;">Metric \u2195</th><th data-sort="itemName" style="cursor:pointer;">Item Name \u2195</th><th data-sort="asin" style="cursor:pointer;">ASIN \u2195</th><th data-sort="category" style="cursor:pointer;">Category \u2195</th><th data-sort="orderId" style="cursor:pointer;">Order ID \u2195</th><th data-sort="locationId" style="cursor:pointer;">Location \u2195</th><th data-sort="pickZone" style="cursor:pointer;">Pick Zone \u2195</th><th data-sort="eventTime" style="cursor:pointer;">Time \u2195</th></tr></thead><tbody>';
                for (var i = 0; i < details.length; i++) { var d = details[i]; var isDone = !!completedMetrics[d.metric];
                    bodyHtml += '<tr data-err-metric="' + (d.metric||'') + '" style="' + (isDone ? 'text-decoration:line-through;color:#94a3b8;opacity:0.6;' : '') + '"><td>' + (d.eventDay||'-') + '</td><td><strong>' + (d.metric||'-') + '</strong></td><td style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + (d.itemName||'').replace(/"/g,'&quot;') + '">' + (d.itemName||'-') + '</td><td>' + (d.asin||'-') + '</td><td>' + (d.category||'-') + '</td><td style="font-size:10px;">' + (d.orderId||'-') + '</td><td>' + (d.locationId||'-') + '</td><td>' + (d.pickZone||'-') + '</td><td>' + (d.eventTime||'-') + '</td></tr>';
                }
                bodyHtml += '</tbody></table>';
            }
        }
        // Cycle Time section — show if this associate has cycle time data
        // Only show the most recent 4 weeks to avoid displaying stale historical data
        var ctData = cycleTimeByLogin[login];
        if (ctData && ctData.length > 0) {
            // Sort by picking week descending (most recent first)
            var sortedCT = ctData.slice().sort(function(a, b) {
                var aWeek = a.pickingWeek || '';
                var bWeek = b.pickingWeek || '';
                return bWeek.localeCompare(aWeek);
            });
            // Only show the most recent 4 weeks
            var recentCT = sortedCT.slice(0, 4);
            bodyHtml += '<div style="margin-top:12px;padding:8px;background:#fef3c7;border:1px solid #fde68a;border-radius:8px;">';
            bodyHtml += '<div style="font-size:11px;font-weight:700;color:#92400e;margin-bottom:6px;">\u23F1 Cycle Time Breakdown (Seconds) (latest ' + recentCT.length + ' of ' + ctData.length + ' week' + (ctData.length !== 1 ? 's' : '') + ')</div>';
            bodyHtml += '<table class="err-table" style="font-size:10px;"><thead><tr><th>Week</th><th>Hrs</th><th>UPH</th><th>ASIN\u2192Post</th><th>Benchmark</th><th>Action to<br>Next Bin(Diff)</th><th>Benchmark</th><th>Action to<br>Next Bin(Same)</th><th>Benchmark</th><th>Post\u2192Slam</th><th>Benchmark</th><th>Bag Prep<br>Error</th><th>Slam Bag<br>Error</th><th>Multi Qty<br>Error</th><th>Loc Scan<br>Error</th></tr></thead><tbody>';
            recentCT.forEach(function(ct) {
                var asinOver = ct.asinToPost > ct.siteBenchmarkASINToPost;
                var nextDiffOver = ct.actionToNextLocationDiffBin > ct.siteBenchmarkActionToNextDiffBin;
                var nextSameOver = ct.actionToNextLocationSameBin > ct.siteBenchmarkActionToNextSameBin;
                var slamOver = ct.postToSlam > ct.siteBenchmarkPostToSlam;
                bodyHtml += '<tr>';
                bodyHtml += '<td>' + (ct.pickingWeek || '-') + '</td>';
                bodyHtml += '<td>' + (ct.weekHours || '-') + '</td>';
                bodyHtml += '<td>' + (ct.uph || '-') + '</td>';
                bodyHtml += '<td style="' + (asinOver ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.asinToPost || '-') + '</td>';
                bodyHtml += '<td style="color:#64748b;">' + (ct.siteBenchmarkASINToPost || '-') + '</td>';
                bodyHtml += '<td style="' + (nextDiffOver ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.actionToNextLocationDiffBin || '-') + '</td>';
                bodyHtml += '<td style="color:#64748b;">' + (ct.siteBenchmarkActionToNextDiffBin || '-') + '</td>';
                bodyHtml += '<td style="' + (nextSameOver ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.actionToNextLocationSameBin || '-') + '</td>';
                bodyHtml += '<td style="color:#64748b;">' + (ct.siteBenchmarkActionToNextSameBin || '-') + '</td>';
                bodyHtml += '<td style="' + (slamOver ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.postToSlam || '-') + '</td>';
                bodyHtml += '<td style="color:#64748b;">' + (ct.siteBenchmarkPostToSlam || '-') + '</td>';
                bodyHtml += '<td style="' + (ct.bagPrepError > 0 ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.bagPrepError || 0) + '</td>';
                bodyHtml += '<td style="' + (ct.slamBagError > 0 ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.slamBagError || 0) + '</td>';
                bodyHtml += '<td style="' + (ct.multiQtyError > 0 ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.multiQtyError || 0) + '</td>';
                bodyHtml += '<td style="' + (ct.locationScanError > 0 ? 'color:#dc2626;font-weight:700;' : '') + '">' + (ct.locationScanError || 0) + '</td>';
                bodyHtml += '</tr>';
            });
            bodyHtml += '</tbody></table></div>';
        }
        bodyHtml += '</div>';
        popup.innerHTML = headerHtml + bodyHtml;
        document.body.appendChild(popup);
        if (anchorEl) { var rect = anchorEl.getBoundingClientRect(); var left = Math.min(rect.left, window.innerWidth - 1220); var top = rect.bottom + 8; if (top + 400 > window.innerHeight) top = Math.max(10, rect.top - 420); popup.style.left = Math.max(10, left) + 'px'; popup.style.top = top + 'px'; }
        else { popup.style.left = '50%'; popup.style.top = '50%'; popup.style.transform = 'translate(-50%,-50%)'; }
        document.getElementById('mm-err-close').addEventListener('click', closeErrDetailsPopup);

        // Filter pills click handler
        popup.querySelectorAll('.err-filter-pill').forEach(function(pill) {
            pill.addEventListener('click', function(e) {
                e.stopPropagation();
                var metric = pill.dataset.metric;
                // Update active state
                popup.querySelectorAll('.err-filter-pill').forEach(function(p) {
                    p.classList.remove('err-filter-active');
                    p.style.outline = 'none';
                    p.style.boxShadow = 'none';
                });
                pill.classList.add('err-filter-active');
                pill.style.outline = '2px solid #FF9900';
                pill.style.boxShadow = '0 0 0 1px #FF9900';
                // Filter rows
                popup.querySelectorAll('tr[data-err-metric]').forEach(function(row) {
                    if (metric === 'ALL' || row.dataset.errMetric === metric) {
                        row.style.display = '';
                    } else {
                        row.style.display = 'none';
                    }
                });
            });
        });
        // Set initial active style on "All"
        var allPill = popup.querySelector('.err-filter-active');
        if (allPill) { allPill.style.outline = '2px solid #FF9900'; allPill.style.boxShadow = '0 0 0 1px #FF9900'; }

        // Column header sort
        var errSortCol = null, errSortAsc = true;
        popup.querySelectorAll('th[data-sort]').forEach(function(th) {
            th.addEventListener('click', function(e) {
                e.stopPropagation();
                var col = th.dataset.sort;
                if (errSortCol === col) errSortAsc = !errSortAsc;
                else { errSortCol = col; errSortAsc = true; }
                // Update header arrows
                popup.querySelectorAll('th[data-sort]').forEach(function(h) {
                    var label = h.textContent.replace(/[\u2195\u25B2\u25BC]/g, '').trim();
                    h.textContent = label + (h.dataset.sort === errSortCol ? (errSortAsc ? ' \u25B2' : ' \u25BC') : ' \u2195');
                });
                // Sort rows
                var tbody = popup.querySelector('tbody');
                if (!tbody) return;
                var rows = Array.from(tbody.querySelectorAll('tr'));
                rows.sort(function(a, b) {
                    var colIdx = { eventDay:0, metric:1, itemName:2, asin:3, category:4, orderId:5, locationId:6, pickZone:7, eventTime:8 };
                    var idx = colIdx[col] !== undefined ? colIdx[col] : 0;
                    var aVal = (a.children[idx] ? a.children[idx].textContent.trim() : '').toLowerCase();
                    var bVal = (b.children[idx] ? b.children[idx].textContent.trim() : '').toLowerCase();
                    if (aVal < bVal) return errSortAsc ? -1 : 1;
                    if (aVal > bVal) return errSortAsc ? 1 : -1;
                    return 0;
                });
                rows.forEach(function(r) { tbody.appendChild(r); });
            });
        });

        // Make error popup draggable by header
        var errHeader = popup.querySelector('.err-header');
        var errDragging = false, errWasDragged = false, errStartX, errStartY, errOrigX, errOrigY;
        errHeader.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            errDragging = true; errWasDragged = false; errStartX = e.clientX; errStartY = e.clientY;
            var rect = popup.getBoundingClientRect(); errOrigX = rect.left; errOrigY = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!errDragging) return;
            errWasDragged = true;
            popup.style.left = (errOrigX + e.clientX - errStartX) + 'px';
            popup.style.top = (errOrigY + e.clientY - errStartY) + 'px';
            popup.style.transform = 'none';
        });
        document.addEventListener('mouseup', function() { errDragging = false; });

        // Escape key to close this popup
        var escHandler = function(e) {
            if (e.key === 'Escape') {
                closeErrDetailsPopup();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    function closeErrDetailsPopup() {
        var existing = document.getElementById('mm-err-popup');
        if (existing) existing.remove();
    }

    // Custom confirm popup for elevate completion
    function showElevateConfirm(login, metric, onYes, onNo) {
        var overlay = document.createElement('div');
        overlay.id = 'mm-elevate-confirm';
        overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:1000000;display:flex;align-items:center;justify-content:center;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:12px;padding:24px 32px;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center;max-width:400px;width:90%;';
        box.innerHTML = '<div style="font-size:16px;font-weight:700;color:#1e293b;margin-bottom:8px;">Confirm Elevate Was Completed</div>' +
            '<div style="font-size:13px;color:#475569;margin-bottom:20px;"><strong>' + metric + '</strong> for <strong>' + login + '</strong></div>' +
            '<div style="display:flex;gap:12px;justify-content:center;">' +
            '<button id="mm-confirm-yes" style="padding:10px 32px;background:#16a34a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;transition:background 0.15s;">Yes</button>' +
            '<button id="mm-confirm-no" style="padding:10px 32px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;transition:background 0.15s;">No</button>' +
            '</div>';
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        document.getElementById('mm-confirm-yes').addEventListener('click', function() { overlay.remove(); if (onYes) onYes(); });
        document.getElementById('mm-confirm-no').addEventListener('click', function() { overlay.remove(); if (onNo) onNo(); });
        overlay.addEventListener('click', function(e) { if (e.target === overlay) { overlay.remove(); if (onNo) onNo(); } });
    }

    // Mark Not Completed — restores a completed elevate item back to the coaching list for everyone
    function markNotCompleted(login, metric) {
        // v41.38: OWN-LOGIN GUARD on EVERY unmark path (not just the Done-Today undo button).
        // A leader may only un-complete a coaching THEY completed. Look up who completed it.
        var me = (GM_getValue('leader_login', '') || '').toLowerCase();
        if (!me) { ctConfirm('Set your login first', 'Click \'set your login\' at the top before undoing.', 'OK', null); return; }
        var completedBy = '';
        try {
            var comp = JSON.parse(GM_getValue('elevateCompleted', '{}'));
            for (var ck in comp) {
                var pp = ck.split('|');
                if ((pp[0]||'').toLowerCase() === (login||'').toLowerCase() && ck.indexOf('|' + metric) !== -1) {
                    completedBy = (comp[ck].completedBy || '').toLowerCase(); break;
                }
            }
        } catch(e) {}
        if (completedBy && completedBy !== me) {
            ctConfirm('Not your completion', 'You can only undo coachings YOU completed.<br><br>Completed by: <b>' + completedBy + '</b><br>You are: <b>' + me + '</b>', 'OK', null);
            return;
        }
        // Log the un-completion — this is the ONLY action needed. Coaching log is source of truth.
        var leader = me || 'unknown';
        addToCoachingLog(login, metric, leader, 'unmarked');
        matchAndAlert();
        console.log('[CoachTracker] Marked NOT completed: ' + login + ' | ' + metric + ' — restored for all users');
    }

    // v41.47: removed dead Engage-era highlightRows() + its MutationObserver entirely
    // (page badging is unused — the panel is the home; the DOM scan was the PC-slowdown source).

    // === BUTTON ===
    function createButton() {
        var btn = document.createElement('button');
        btn.id = 'mm-btn'; btn.className = 'ct-launch loading'; btn.innerHTML = '<span class="ct-launch-ico">\uD83D\uDCCB</span><span class="ct-launch-txt">Coaching</span><span class="ct-launch-badge">\u2014</span>';
        btn.onclick = togglePanel;
        var isDragging = false, offsetX, offsetY;
        btn.addEventListener('mousedown', function(e) {
            isDragging = false; offsetX = e.clientX - btn.getBoundingClientRect().left; offsetY = e.clientY - btn.getBoundingClientRect().top;
            function onMove(e) { isDragging = true; btn.style.right = 'auto'; btn.style.bottom = 'auto'; btn.style.left = (e.clientX - offsetX) + 'px'; btn.style.top = (e.clientY - offsetY) + 'px'; }
            function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); if (isDragging) GM_setValue('btnPos', JSON.stringify({left: btn.style.left, top: btn.style.top})); }
            document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
        });
        btn.addEventListener('click', function(e) { if (isDragging) { e.stopImmediatePropagation(); isDragging = false; } }, true);
        document.body.appendChild(btn);
        // v42.9 ON-SCREEN CLAMP: a saved drag position could be off-screen (window resized/smaller),
        // making the launcher 'disappear'. Validate the saved coords are within the viewport; if not,
        // discard them and fall back to the default bottom-right corner so the button is always visible.
        var saved = GM_getValue('btnPos', null);
        if (saved) {
            try {
                var pos = JSON.parse(saved);
                var L = parseInt(pos.left, 10), T = parseInt(pos.top, 10);
                var onScreen = !isNaN(L) && !isNaN(T) && L >= 0 && T >= 0
                    && L <= (window.innerWidth - 40) && T <= (window.innerHeight - 30);
                if (onScreen) { btn.style.right = 'auto'; btn.style.bottom = 'auto'; btn.style.left = pos.left; btn.style.top = pos.top; }
                else { GM_setValue('btnPos', ''); }   // bad/off-screen -> reset to default corner
            } catch(e) { GM_setValue('btnPos', ''); }
        }
        return btn;
    }

    function updateButton() {
        var btn = document.getElementById('mm-btn');
        if (!btn) return;
        // Count total PENDING coachings across on-site matches (what's left to coach).
        var pending = 0;
        for (var i = 0; i < currentMatches.length; i++) { pending += (currentMatches[i].alerts || []).length; }
        var ico = btn.querySelector('.ct-launch-ico');
        var txt = btn.querySelector('.ct-launch-txt');
        var badge = btn.querySelector('.ct-launch-badge');
        if (!ico || !txt || !badge) { btn.innerHTML = '<span class="ct-launch-ico">\uD83D\uDCCB</span><span class="ct-launch-txt">Coaching</span><span class="ct-launch-badge">\u2014</span>'; ico = btn.querySelector('.ct-launch-ico'); txt = btn.querySelector('.ct-launch-txt'); badge = btn.querySelector('.ct-launch-badge'); }
        if (currentMatches.length > 0) {
            btn.className = 'ct-launch has-pending';
            ico.textContent = '\uD83D\uDEA8';
            badge.textContent = pending;
            badge.style.display = '';
        } else if (dataLoaded && engageEmployees.length > 0) {
            btn.className = 'ct-launch ok';
            ico.textContent = '\u2705';
            badge.textContent = '0';
            badge.style.display = 'none';
        } else {
            btn.className = 'ct-launch loading';
            ico.textContent = '\u23F3';
            badge.style.display = 'none';
        }
    }

    // === PANEL ===
    var activeFilters = [];
    var activeElevMetric = []; // array of active elevate metric filters
    var activeSearch = ''; // search text filter
    var activeSort = 'metric'; // sort option — default to metric grouping
    var expandedLogins = {}; // v41.14: compact-home model — login -> true means its detail card is expanded
    var hiddenTypes = JSON.parse(GM_getValue('hiddenTypes', '[]')); // types hidden from view (PUNCH, MEAL)

    // v38: guarded 'mark ALL pending complete'. Hidden in the overflow menu + confirm dialog
    // so a stray click can't wipe the team's list. Each completion is attributed to the leader
    // and synced to Firebase (so the team dedupe holds).
    // v38: build shift-group buckets from currently-pending coachings (dynamic — morning/day/night
    // all captured; blank Today's Shift -> "Unscheduled today"). Site-agnostic.
    function buildShiftGroups() {
        var groups = {}; // label -> [{login, metric}]
        for (var i = 0; i < currentMatches.length; i++) {
            var m = currentMatches[i];
            (m.alerts || []).forEach(function(a) {
                if (a.type !== 'ELEV' && a.type !== 'POS') return;
                var sh = (a.shift || '').trim();
                var label = sh ? sh : 'Unscheduled today';
                if (!groups[label]) groups[label] = [];
                groups[label].push({ login: m.login, metric: a.metric });
            });
        }
        return groups;
    }

    // v38: Team Coaching Summary — per-leader tally of completed coachings, computed from the
    // shared coaching log. First completer of each login|metric gets the credit; 'unmarked' undoes it.
    // Shown in a modal (opened from the ⋯ menu) — good for team accountability + handoff visibility.
    function showTeamSummary() {
        var completedPairs = {}; // login|metric -> first completedBy
        var lastTs = {};         // leader -> latest completion timestamp
        for (var i = 0; i < coachingLog.length; i++) {
            var e = coachingLog[i];
            if (!e || !e.login) continue;
            var pk = ckey(e.login, e.metric);
            if (e.action === 'completed' && isRealLeader(e.completedBy)) {   // v39.3: exclude auto/non-leader
                if (!completedPairs[pk]) completedPairs[pk] = e.completedBy;
            } else if (e.action === 'unmarked') {
                delete completedPairs[pk];
            }
        }
        var totals = {};
        for (var pk2 in completedPairs) { var l = completedPairs[pk2]; totals[l] = (totals[l] || 0) + 1; }
        // latest timestamp per surviving-credited leader
        for (var j = 0; j < coachingLog.length; j++) {
            var e2 = coachingLog[j];
            if (e2.action === 'completed' && isRealLeader(e2.completedBy) && e2.timestamp) {
                var pk3 = ckey(e2.login, e2.metric);
                if (completedPairs[pk3] === e2.completedBy) {
                    if (!lastTs[e2.completedBy] || e2.timestamp > lastTs[e2.completedBy]) lastTs[e2.completedBy] = e2.timestamp;
                }
            }
        }
        var leaders = Object.keys(totals).sort(function(a, b) { return totals[b] - totals[a]; });
        var grand = leaders.reduce(function(s, l) { return s + totals[l]; }, 0);

        var prior = document.getElementById('mm-markall-modal'); if (prior) prior.remove();
        var overlay = document.createElement('div');
        overlay.id = 'mm-markall-modal';
        overlay.className = 'mm-modal-overlay';
        var rows = '';
        if (leaders.length === 0) {
            rows = '<div class="mm-modal-sub">No coachings completed yet.</div>';
        } else {
            rows = '<table class="mm-sum-table"><thead><tr><th>Leader</th><th>Completed</th><th>Last</th></tr></thead><tbody>';
            leaders.forEach(function(l) {
                var t = lastTs[l] ? new Date(lastTs[l]) : null;
                var when = t ? ((t.getMonth() + 1) + '/' + t.getDate() + ' ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '-';
                rows += '<tr><td><b>' + l + '</b></td><td>' + totals[l] + '</td><td>' + when + '</td></tr>';
            });
            rows += '</tbody></table>';
        }
        overlay.innerHTML = '<div class="mm-modal">'
            + '<div class="mm-modal-h">\uD83C\uDFC6 Team Coaching Summary</div>'
            + '<div class="mm-modal-sub">' + grand + ' coaching(s) completed \u2014 credited to first completer.</div>'
            + rows
            + '<div class="mm-modal-foot"><button class="mm-modal-cancel" id="mm-sum-close">Close</button></div>'
            + '</div>';
        document.body.appendChild(overlay);
        document.getElementById('mm-sum-close').addEventListener('click', function() { overlay.remove(); });
        overlay.addEventListener('click', function(ev) { if (ev.target === overlay) overlay.remove(); });
    }

    // Two-layer guarded mark-all: STEP 1 pick scope (All / a shift group / Unscheduled),
    // STEP 2 "are you sure?" confirm. Requires two deliberate yes's — no single-click accidents.
    function markAllPendingComplete() {
        var leader = getLeaderLogin();
        if (!leader) { alert('Set your login first (needed to attribute completions).'); return; }
        var groups = buildShiftGroups();
        var labels = Object.keys(groups);
        var total = labels.reduce(function(s, l) { return s + groups[l].length; }, 0);
        if (total === 0) { alert('No pending coachings to mark complete.'); return; }

        // Remove any prior modal
        var prior = document.getElementById('mm-markall-modal'); if (prior) prior.remove();

        var overlay = document.createElement('div');
        overlay.id = 'mm-markall-modal';
        overlay.className = 'mm-modal-overlay';

        // STEP 1 — scope picker
        var scopeBtns = '<button class="mm-scope-btn" data-scope="__ALL__">All pending <b>' + total + '</b></button>';
        // Sort shift labels: real shifts first (by time), Unscheduled last
        labels.sort(function(a, b) {
            if (a === 'Unscheduled today') return 1;
            if (b === 'Unscheduled today') return -1;
            return a.localeCompare(b);
        });
        labels.forEach(function(l) {
            scopeBtns += '<button class="mm-scope-btn" data-scope="' + l.replace(/"/g, '&quot;') + '">' + l + ' <b>' + groups[l].length + '</b></button>';
        });

        overlay.innerHTML = '<div class="mm-modal">'
            + '<div class="mm-modal-h">Mark coachings complete</div>'
            + '<div class="mm-modal-sub">Step 1 of 2 — choose which group to complete:</div>'
            + '<div class="mm-scope-list">' + scopeBtns + '</div>'
            + '<div class="mm-modal-foot"><button class="mm-modal-cancel" id="mm-markall-cancel">Cancel</button></div>'
            + '</div>';
        document.body.appendChild(overlay);

        function close() { overlay.remove(); }
        document.getElementById('mm-markall-cancel').addEventListener('click', close);
        overlay.addEventListener('click', function(e) { if (e.target === overlay) close(); });

        // Delegated: pick a scope -> STEP 2 confirm
        overlay.addEventListener('click', function(e) {
            var b = e.target.closest('.mm-scope-btn');
            if (!b) return;
            var scope = b.getAttribute('data-scope');
            var items = (scope === '__ALL__')
                ? labels.reduce(function(acc, l) { return acc.concat(groups[l]); }, [])
                : (groups[scope] || []);
            var scopeLabel = (scope === '__ALL__') ? 'ALL pending' : scope;
            // STEP 2 — confirm
            var modal = overlay.querySelector('.mm-modal');
            modal.innerHTML = '<div class="mm-modal-h">Are you sure?</div>'
                + '<div class="mm-modal-sub">You are about to mark <b>' + items.length + '</b> coaching(s) complete for <b>' + scopeLabel + '</b>.<br>This updates the whole team\'s shared list.</div>'
                + '<div class="mm-modal-foot">'
                + '<button class="mm-modal-cancel" id="mm-markall-back">Cancel</button>'
                + '<button class="mm-modal-go" id="mm-markall-go">Yes, mark ' + items.length + ' complete</button>'
                + '</div>';
            document.getElementById('mm-markall-back').addEventListener('click', close);
            document.getElementById('mm-markall-go').addEventListener('click', function() {
                var done = 0;
                for (var k = 0; k < items.length; k++) {
                    if (!isElevateCompleted(items[k].login, items[k].metric)) {
                        addToCoachingLog(items[k].login, items[k].metric, leader, 'completed');
                        done++;
                    }
                }
                close();
                matchAndAlert();
                console.log('[CoachTracker] Mark-all (' + scopeLabel + '): completed ' + done + ' by ' + leader);
            });
        });
    }

    // v39.2: attach the delegated click listeners ONCE on #mm-content (persistent parent).
    // MUST be attached at panel-creation time so tiles/chips work in EVERY render path —
    // including the empty-state branch, which previously returned before wiring them (bug: tiles did nothing).
    function attachDashListeners(content) {
        if (!content || content.__ctDashDelegated) return;
        content.__ctDashDelegated = true;
        content.addEventListener('click', function(ev) {
            // v41.14: compact-home expand/collapse. Click a login row to toggle its detail card.
            // Ignore clicks on interactive children (links/badges/copy) so those still work.
            var toggleRow = ev.target.closest('[data-toggle-login]');
            if (toggleRow && content.contains(toggleRow)) {
                if (!ev.target.closest('a, button, .mm-badge, .mm-elevate-link, .mm-login-copy, .mm-err-btn')) {
                    var lg = toggleRow.getAttribute('data-toggle-login');
                    if (expandedLogins[lg]) delete expandedLogins[lg]; else expandedLogins[lg] = true;
                    updatePanel();
                    return;
                }
            }
            // v41.29: METRIC FILTER CHIPS (delegated so they survive re-renders — the old
            // per-render addEventListener died on every updatePanel, so clicking did nothing).
            // Elevate-metric chips (Item Quality, IB Receive Errors, etc.) filter the pending list.
            var emPill = ev.target.closest('.mm-type-pill[data-elevmetric]');
            if (emPill && content.contains(emPill)) {
                var em = emPill.getAttribute('data-elevmetric');
                if (em === 'ALL') { activeElevMetric = []; }
                else { var i0 = activeElevMetric.indexOf(em); if (i0 >= 0) activeElevMetric.splice(i0,1); else activeElevMetric.push(em); }
                updatePanel();
                return;
            }
            // Elevate / Positive / All type chips.
            var tPill = ev.target.closest('.mm-type-pill[data-filter]');
            if (tPill && content.contains(tPill)) {
                var f = tPill.getAttribute('data-filter');
                if (f === 'ALL') { activeFilters = []; activeElevMetric = []; }
                else { var i1 = activeFilters.indexOf(f); if (i1 >= 0) activeFilters.splice(i1,1); else activeFilters.push(f); }
                updatePanel();
                return;
            }
            // Dashboard filter tiles / metric pills
            var el = ev.target.closest('[data-filter]');
            if (el && content.contains(el) && !ev.target.closest('.mm-type-pill')) {
                var kind = el.getAttribute('data-filter');
                var value = el.getAttribute('data-value');
                if (kind === 'all') { activeDashFilter = null; }
                else if (activeDashFilter && activeDashFilter.kind === kind && (value == null || activeDashFilter.value === value)) { activeDashFilter = null; }
                else { activeDashFilter = { kind: kind }; if (value != null) activeDashFilter.value = value; }
                updatePanel();
                return;
            }
            // Dropdown chips
            var chip = ev.target.closest('.ct-drop-chip');
            if (chip) {
                var which = chip.getAttribute('data-drop');
                var dp = document.getElementById('ct-drop-' + which);
                var willOpen = dp && dp.style.display === 'none';
                // v39.3: ACCORDION — close ALL dropdown panels + reset ALL chip arrows first,
                // then open only the clicked one. Opening one closes the others.
                [].slice.call(document.querySelectorAll('.ct-drop-panel')).forEach(function(p){ p.style.display = 'none'; });
                [].slice.call(document.querySelectorAll('.ct-drop-chip')).forEach(function(c){ c.textContent = '\u25B8 ' + c.textContent.replace(/^[\u25B8\u25BE]\s*/, ''); });
                if (willOpen && dp) {
                    dp.style.display = 'block';
                    chip.textContent = '\u25BE ' + chip.textContent.replace(/^[\u25B8\u25BE]\s*/, '');
                }
                return;
            }
            // Hide-type toggle
            var ht = ev.target.closest('.ct-hide-toggle');
            if (ht) {
                var type = ht.getAttribute('data-hidetype');
                var idx = hiddenTypes.indexOf(type);
                if (idx >= 0) hiddenTypes.splice(idx, 1); else hiddenTypes.push(type);
                GM_setValue('hiddenTypes', JSON.stringify(hiddenTypes));
                matchAndAlert();
                return;
            }
            // Undo — v41.34: OWN-LOGIN ONLY + IN-PANEL TRIPLE CONFIRM (ctConfirm, not native confirm()).
            var undo = ev.target.closest('.ct-undo-btn');
            if (undo) {
                var ul = undo.getAttribute('data-login');
                var um = undo.getAttribute('data-metric');
                var completedBy = (undo.getAttribute('data-by') || '').toLowerCase();
                var me = (getLeaderLogin() || '').toLowerCase();
                if (!me) { ctConfirm('Set your login first', 'Click \'set your login\' at the top before undoing.', 'OK', null); return; }
                if (completedBy && completedBy !== me) {
                    ctConfirm('Not your completion', 'You can only undo coachings YOU completed.<br><br>Completed by: <b>' + completedBy + '</b><br>You are: <b>' + me + '</b>', 'OK', null);
                    return;
                }
                ctConfirm('Undo this completion?', ul + ' \u2014 ' + um, 'Undo\u2026', function(){
                    ctConfirm('Are you sure?', 'This will put the coaching back on the pending list.', 'Yes, continue', function(){
                        ctConfirm('FINAL CONFIRM', 'Undo <b>' + ul + '</b> \u2014 ' + um + '?<br><br>Only if completed by mistake.', 'Confirm undo', function(){
                            addToCoachingLog(ul, um, me, 'unmarked');
                            matchAndAlert();
                        });
                    });
                });
                return;
            }
        });
    }

    function createPanel() {
        var p = document.createElement('div');
        p.id = 'mm-panel';
        p.innerHTML = '<div class="mm-header" id="mm-drag-handle" style="cursor:grab;user-select:none;"><h3>\uD83D\uDEA8 Coaching Tracker <span style=\"font-size:9px;font-weight:600;color:#ff9900;vertical-align:middle;\">v' + CURRENT_VERSION + '</span></h3><div style="display:flex;align-items:center;gap:2px;position:relative;"><button class="mm-ico" id="mm-more" data-tip="More">\u22EF</button><div id="mm-more-menu" class="mm-more-menu" style="display:none;"><button id="mm-teamsummary" class="mm-more-item mm-more-item-neutral">\uD83C\uDFC6 Team coaching summary</button><button id="mm-markall" class="mm-more-item">\u2713 Mark ALL pending complete</button></div><button class="mm-ico" id="mm-size" data-tip="Resize">\u2922</button><button class="mm-ico" id="mm-min" data-tip="Minimize">\u2013</button><button class="mm-ico mm-close" id="mm-close" data-tip="Close">&times;</button></div></div><div class="mm-body"><div id="mm-content"></div></div>';
        document.body.appendChild(p);
        attachDashListeners(document.getElementById('mm-content'));
        document.getElementById('mm-close').onclick = function() { p.classList.remove('visible'); var _b = document.getElementById('mm-btn'); if (_b) _b.style.display = ''; };
        // v38: ⋯ overflow menu (hidden mark-all, guarded by confirm)
        var moreBtn = document.getElementById('mm-more');
        var moreMenu = document.getElementById('mm-more-menu');
        if (moreBtn && moreMenu) {
            moreBtn.addEventListener('click', function(e){ e.stopPropagation(); moreMenu.style.display = (moreMenu.style.display === 'none' ? 'block' : 'none'); });
            document.addEventListener('click', function(){ if (moreMenu) moreMenu.style.display = 'none'; });
            var markAllBtn = document.getElementById('mm-markall');
            if (markAllBtn) markAllBtn.addEventListener('click', function(e){
                e.stopPropagation();
                moreMenu.style.display = 'none';
                markAllPendingComplete();
            });
            var teamSumBtn = document.getElementById('mm-teamsummary');
            if (teamSumBtn) teamSumBtn.addEventListener('click', function(e){
                e.stopPropagation();
                moreMenu.style.display = 'none';
                showTeamSummary();
            });
        }
        var sizeBtn = document.getElementById('mm-size');
        // v42.7: SIZE CYCLE Normal -> Large -> XL -> Normal (session-only, never persisted so it
        // can't get stuck oversized). Matches the Outbound Labor Pilot resize pattern.
        var ctSizeStep = 0;   // 0=Normal, 1=Large, 2=XL
        if (sizeBtn) sizeBtn.addEventListener('click', function(e){
            e.stopPropagation();
            ctSizeStep = (ctSizeStep + 1) % 3;
            p.classList.remove('ct-size-lg','ct-size-xl');
            if (ctSizeStep === 1) { p.classList.add('ct-size-lg'); sizeBtn.setAttribute('data-tip','Large \u2014 click for XL'); }
            else if (ctSizeStep === 2) { p.classList.add('ct-size-xl'); sizeBtn.setAttribute('data-tip','XL \u2014 click for Normal'); }
            else { sizeBtn.setAttribute('data-tip','Normal \u2014 click to enlarge'); }
        });
        var minBtn = document.getElementById('mm-min');
        if (minBtn) minBtn.addEventListener('click', function(e){ e.stopPropagation(); p.classList.toggle('minimized'); minBtn.textContent = p.classList.contains('minimized') ? '\u2610' : '\u2013'; minBtn.setAttribute('data-tip', p.classList.contains('minimized') ? 'Expand' : 'Minimize'); });

        // Draggable
        var handle = document.getElementById('mm-drag-handle');
        var dragging = false, startX, startY, origX, origY;
        handle.addEventListener('mousedown', function(e) {
            if (e.target.tagName === 'BUTTON') return;
            dragging = true; startX = e.clientX; startY = e.clientY;
            var rect = p.getBoundingClientRect(); origX = rect.left; origY = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', function(e) {
            if (!dragging) return;
            p.style.left = (origX + e.clientX - startX) + 'px';
            p.style.top = (origY + e.clientY - startY) + 'px';
            p.style.right = 'auto'; p.style.bottom = 'auto';
        });
        document.addEventListener('mouseup', function() { dragging = false; });

        // Esc: only close error popup if open, otherwise close panel
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                var errPopup = document.getElementById('mm-err-popup');
                if (errPopup) { closeErrDetailsPopup(); }
                else if (p.classList.contains('visible')) { p.classList.remove('visible'); }
            }
        });
        return p;
    }

    function togglePanel() {
        var p = document.getElementById('mm-panel');
        if (!p) p = createPanel();
        p.classList.toggle('visible');
        // v42.13: hide the launcher while the panel is open so it can never overlap or
        // intercept clicks on the header buttons (Resize / More). Restored on close.
        var _b = document.getElementById('mm-btn');
        if (_b) _b.style.display = p.classList.contains('visible') ? 'none' : '';
        updatePanel();
    }

    function updatePanel() {
        var content = document.getElementById('mm-content');
        if (!content) return;

        var elevateCount = Object.keys(elevateByLogin).length;
        var elevateTs = GM_getValue('elevateTimestamp', 0);
        var elevateAge = elevateTs ? Math.round((Date.now() - elevateTs) / 60000) : null;
        var elevateAgeStr = elevateAge !== null ? (elevateAge < 60 ? elevateAge + 'min ago' : Math.round(elevateAge/60) + 'h ago') : '';
        var elevateStatus = elevateCount > 0
            ? '\u2705 ' + elevateCount + ' associates' + (elevateAgeStr ? ' (' + elevateAgeStr + ')' : '')
            : '\uD83D\uDCC2 Drop Elevate CSV or click to upload';

        // Error details status
        var errDetailCount = Object.keys(coachingErrDetails).length;
        var errTs = GM_getValue('errDetailsTimestamp', 0);
        var errAge = errTs ? Math.round((Date.now() - errTs) / 60000) : null;
        var errAgeStr = errAge !== null ? (errAge < 60 ? errAge + 'min ago' : Math.round(errAge/60) + 'h ago') : '';
        var errStatus = errDetailCount > 0
            ? '\u2705 ' + errDetailCount + ' associates' + (errAgeStr ? ' (' + errAgeStr + ')' : '')
            : '\uD83D\uDD0D Use Elevate Error Scraper on QuickSight to pull error data';

        var dataHidden = GM_getValue('mm_data_hidden', false);
        var logHidden = GM_getValue('mm_log_hidden', true);
        var hideHidden = GM_getValue('mm_hide_hidden', true);
        // v38: lean status line only — CSV upload, manual lookup, coaching-log table, hide-types,
        // summary block, error-details, and positive-fetch button all removed. Data auto-scrapes from
        // QuickSight; the coaching log still exists in memory for "Done today" + dedupe, just not rendered.
        var leaderLogin = GM_getValue('leader_login', '');
        var currentSite = ELEVATE_SITE_CODE || 'auto-detecting…';
        var statusHtml = '<div class="ct-status">'
            + '<span>\uD83C\uDFED <b>' + currentSite + '</b> <span id="mm-site-change" class="ct-link">(change)</span></span>'
            + '<span>' + (leaderLogin
                ? '\uD83D\uDC64 <b>' + leaderLogin + '</b> <span id="mm-leader-change" class="ct-link">(change)</span>'
                : '\uD83D\uDC64 <span id="mm-leader-set" class="ct-link" style="color:#dc2626;">set your login</span>')
            + '</span>'
            + '<span class="ct-synced">\uD83D\uDD25 Synced</span>'
            + '</div>'
            + '<div id="mm-leader-section" style="display:none;margin:0 14px 8px;"><div style="display:flex;gap:4px"><input id="mm-leader-input" type="text" placeholder="Your login" value="' + leaderLogin + '" style="flex:1;padding:5px 8px;background:#f8fafc;border:1px solid #e2e8f0;color:#1e293b;border-radius:6px;font-size:11px"><button id="mm-leader-save" style="padding:5px 12px;background:#16a34a;color:#fff;border:none;border-radius:6px;font-size:11px;cursor:pointer;font-weight:700">Save</button></div></div>';

        // v39: collapsible dropdown chips under the dashboard (collapsed by default).
        // Wired via a delegated listener (survives innerHTML re-renders). Sections: Coaching Log,
        // Team Summary, Hide Types, Completed (with undo).
        statusHtml += '<div class="ct-drops">'
            + '<button class="ct-drop-chip" data-drop="log">\u25B8 Coaching Log</button>'
            + '<button class="ct-drop-chip" data-drop="summary">\u25B8 Team Summary</button>'
            + '<button class="ct-drop-chip" data-drop="hide">\u25B8 Hide Types</button>'
            + '<button class="ct-drop-chip" data-drop="completed">\u25B8 Done Today (by leader)</button>'
            + '</div>'
            + '<div id="ct-drop-log" class="ct-drop-panel" style="display:none;">' + buildLogHTML() + '</div>'
            + '<div id="ct-drop-summary" class="ct-drop-panel" style="display:none;">' + buildSummaryHTML() + '</div>'
            + '<div id="ct-drop-hide" class="ct-drop-panel" style="display:none;">' + buildHideTypesHTML() + '</div>'
            + '<div id="ct-drop-completed" class="ct-drop-panel" style="display:none;">' + buildCompletedHTML() + '</div>';

        // v38: DASHBOARD ALWAYS FIRST — renders even while employee data is still loading.
        if (currentMatches.length === 0) {
            // v39: DIAGNOSTIC empty-state (Find People architecture) so it's clear WHERE it's stuck.
            var emptyMsg;
            var coachingCount = Object.keys(elevateByLogin).length + Object.keys(positiveByLogin).length;
            if (onSiteCount > 0) {
                emptyMsg = '<div class="mm-allclear">\u2705 ' + onSiteCount + ' on site \u00b7 ' + coachingCount + ' associates have coachings. No on-site overlap with pending coachings right now.</div>';
            } else {
                emptyMsg = '<div class="ct-loading">\u23F3 On-site roster not loaded yet.<br>on-site: ' + onSiteCount + ' \u00b7 coachings(FB): ' + coachingCount + ' \u00b7 siteId: ' + (fpSiteId ? '\u2713' : 'not captured') + '<br><span style="font-size:10px;color:#94a3b8;">Select your site on the Find People page so it loads the live roster. Keep the QuickSight coaching tab open so coachings sync.</span></div>';
            }
            content.innerHTML = buildDashboardHTML() + statusHtml + emptyMsg;
            attachUploadHandlers();
            return;
        }

        // Count by type
        var typeCounts = {};
        currentMatches.forEach(function(m) { m.alerts.forEach(function(a) { typeCounts[a.type] = (typeCounts[a.type] || 0) + 1; }); });

        var html = buildDashboardHTML() + statusHtml;

        // Summary bar
        // Calculate completion progress
        // v39.2: count only CURRENT-WEEK completions (week-scoped keys end with |<currentCoachingWeek>).
        var _compObj = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var completedCount = 0;
        var _wkSuffix = '|' + (currentCoachingWeek || '');
        Object.keys(_compObj).forEach(function(k){ if (!currentCoachingWeek || k.slice(-_wkSuffix.length) === _wkSuffix) completedCount++; });
        // Total this-week coachings = distinct current-week elevate entries.
        var totalElevateCoachings = 0;
        for (var ek in elevateByLogin) {
            (elevateByLogin[ek] || []).forEach(function(e){ if (!currentCoachingWeek || e.week === currentCoachingWeek) totalElevateCoachings++; });
        }
        // Denominator = everything to coach this week (done + still pending). Cap at 100%.
        var _denom = Math.max(totalElevateCoachings, completedCount);
        var progressPct = _denom > 0 ? Math.min(100, Math.round((completedCount / _denom) * 100)) : 0;

        // v41.15: REMOVED the progress bar entirely — 'coached today vs. remaining' is misleading
        // here (you coach whoever is on-site now, not the whole week's list). Kept only a slim strip
        // with Copy Remaining + last-synced time.
        var lastSyncTs = GM_getValue('elevateTimestamp', 0);
        var lastSyncStr = lastSyncTs ? new Date(lastSyncTs).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : 'never';
        // v41.37: removed 'Copy Remaining' button (unused clutter). Just show last-synced time.
        html += '<div style="text-align:right;margin:0 14px 8px;font-size:9px;color:#94a3b8;">Last synced: ' + lastSyncStr + '</div>';

        // v41.14: removed redundant 'N on site need coaching' banner + duplicate metric-pill row
        // (mm-summary/mm-type-summary) — that count is the Pending tile, and the pills duplicate the
        // filter bar below. Single filter row (mm-filter-bar) is the source of truth now.

        // Filter bar
        html += '<div class="mm-filter-bar"><span class="mm-filter-label">Filter:</span>';
        html += '<span class="mm-type-pill' + (activeFilters.length === 0 ? ' active-filter' : ' inactive') + '" data-filter="ALL" style="background:#475569;font-size:10px;padding:3px 10px;">All</span>';
        for (var ft in typeCounts) {
            var fcfg = getTypeConfig(ft);
            var fActive = activeFilters.indexOf(ft) >= 0;
            html += '<span class="mm-type-pill' + (fActive ? ' active-filter' : (activeFilters.length === 0 ? '' : ' inactive')) + '" data-filter="' + ft + '" style="background:' + fcfg.bg + ';font-size:10px;padding:3px 10px;">' + fcfg.label + '</span>';
        }
        html += '</div>';

        // Elevate metric sub-filters (show when Elevate filter is active)
        if (activeFilters.indexOf('ELEV') >= 0 || (activeFilters.length === 0 && typeCounts['ELEV'])) {
            var elevMetricCounts = {};
            currentMatches.forEach(function(m) {
                m.alerts.forEach(function(a) {
                    if (a.type === 'ELEV' && a.metric) { elevMetricCounts[a.metric] = (elevMetricCounts[a.metric] || 0) + 1; }
                });
            });
            if (Object.keys(elevMetricCounts).length > 1) {
                html += '<div class="mm-filter-bar" style="padding-top:4px;"><span class="mm-filter-label">Elevate Metric:</span>';
                html += '<span class="mm-type-pill' + (activeElevMetric.length === 0 ? ' active-filter' : ' inactive') + '" data-elevmetric="ALL" style="background:#475569;font-size:9px;padding:2px 8px;">All</span>';
                for (var em in elevMetricCounts) {
                    var emActive = activeElevMetric.indexOf(em) >= 0;
                    html += '<span class="mm-type-pill' + (emActive ? ' active-filter' : (activeElevMetric.length === 0 ? '' : ' inactive')) + '" data-elevmetric="' + em + '" style="background:#E74C3C;font-size:9px;padding:2px 8px;">' + em + ' (' + elevMetricCounts[em] + ')</span>';
                }
                html += '</div>';
            }
        }

        // Filtered matches
        var filtered = currentMatches;
        // v37: apply the clickable dashboard filter first (tiles / metric pills).
        if (activeDashFilter && activeDashFilter.kind !== 'all') {
            var adf = activeDashFilter;
            filtered = filtered.map(function(m) {
                var kept = (m.alerts || []).filter(function(a) {
                    if (adf.kind === 'pending') return true; // all pending already
                    if (adf.kind === 'inprogress') return !!getActiveClaim(m.login, a.metric);
                    if (adf.kind === 'positive') return a.type === 'POS';
                    if (adf.kind === 'metric') return (a.metric || '') === adf.value;
                    if (adf.kind === 'done') return false; // handled separately below
                    return true;
                });
                return kept.length ? Object.assign({}, m, { alerts: kept }) : null;
            }).filter(Boolean);
            // 'done' shows nothing from pending list (completed items live in the log section)
            if (adf.kind === 'done') filtered = [];
        }
        if (activeFilters.length > 0) {
            filtered = filtered.filter(function(m) {
                return m.alerts.some(function(a) {
                    if (activeFilters.indexOf(a.type) < 0) return false;
                    if (a.type === 'ELEV' && activeElevMetric.length > 0 && activeElevMetric.indexOf(a.metric) < 0) return false;
                    return true;
                });
            });
        } else if (activeElevMetric.length > 0) {
            filtered = filtered.filter(function(m) {
                return m.alerts.some(function(a) { return a.type === 'ELEV' && activeElevMetric.indexOf(a.metric) >= 0; });
            });
        }

        html += '<div style="padding:4px 14px;display:flex;gap:8px;align-items:center;"><input id="mm-search" type="text" placeholder="\uD83D\uDD0D Search by name or login..." style="flex:1;padding:6px 10px;border:1px solid #e2e8f0;border-radius:8px;font-size:12px;box-sizing:border-box;" value="' + (activeSearch || '') + '"><select id="mm-sort" style="padding:4px 6px;border:1px solid #e2e8f0;border-radius:6px;font-size:10px;font-weight:600;color:#475569;"><option value="count"' + (activeSort === 'count' ? ' selected' : '') + '>Sort: Coaching Count</option><option value="name"' + (activeSort === 'name' ? ' selected' : '') + '>Sort: Name A-Z</option><option value="errors"' + (activeSort === 'errors' ? ' selected' : '') + '>Sort: Error Count</option><option value="metric"' + (activeSort === 'metric' ? ' selected' : '') + '>Sort: Metric Type</option></select></div>';

        html += '<div class="mm-list">';
        // Apply search filter
        if (activeSearch) {
            var searchLower = activeSearch.toLowerCase();
            filtered = filtered.filter(function(m) { return m.name.toLowerCase().indexOf(searchLower) !== -1 || m.login.indexOf(searchLower) !== -1; });
        }
        // Apply sort
        if (activeSort === 'name') { filtered.sort(function(a, b) { return a.name.localeCompare(b.name); }); }
        else if (activeSort === 'errors') { filtered.sort(function(a, b) { return ((coachingErrDetails[b.login]||[]).length) - ((coachingErrDetails[a.login]||[]).length); }); }
        else if (activeSort === 'metric') { filtered.sort(function(a, b) { var am = a.alerts.find(function(x){return x.type==='ELEV';}); var bm = b.alerts.find(function(x){return x.type==='ELEV';}); return ((am?am.metric:'')+'').localeCompare((bm?bm.metric:'')+'')}); }
        for (var k = 0; k < filtered.length; k++) {
            var m = filtered[k];
            var visibleAlerts = activeFilters.length > 0 ? m.alerts.filter(function(a) { return activeFilters.indexOf(a.type) >= 0; }) : m.alerts;
            var hasElevate = visibleAlerts.some(function(a) { return a.type === 'ELEV'; });
            var errCount = (coachingErrDetails[m.login] || []).length;
            var hasCycleTimeMetric = m.alerts.some(function(a) { return a.metric && a.metric.toLowerCase().indexOf('combined cycle') !== -1; });
            if (hasCycleTimeMetric) errCount += 1;

            html += '<div class="mm-item">';
            // v41.14 COMPACT HOME: default = one clickable login row (no full name). Click to expand
            // the full detail card (name, metric badges, ✓ complete, Open Form). One less thing on screen.
            var _isOpen = !!expandedLogins[m.login];
            var _typeDots = '';
            (function(){
                var seen = {};
                visibleAlerts.forEach(function(a){ var cfg = getTypeConfig(a.type); if(!seen[a.type]){ seen[a.type]=1; _typeDots += '<span class="mm-dot" style="background:'+cfg.bg+';"></span>'; } });
            })();
            html += '<div class="mm-compact" data-toggle-login="' + m.login + '">'
                + '<span class="lg">' + m.login + '</span>'
                + '<span class="rt">' + _typeDots
                + '<span class="mm-cnt">' + visibleAlerts.length + '</span>'
                + '<span class="mm-chev">' + (_isOpen ? '\u25BE' : '\u25B8') + '</span>'
                + '</span></div>';
            if (_isOpen) {
            // v41.11: ALWAYS show Full Name + login together. Title = "Full Name (login)". If the
            // full name wasn't captured, show the login as the name but keep the (login) suffix so
            // it's never ambiguous which is which.
            // v41.13: inline HTML-escape (the previous esc() lived only inside qsRowsToCSV -> it was
            // undefined here, which threw a ReferenceError and left the panel body EMPTY). This local
            // helper is always in scope.
            function _h(v){ return (v == null ? '' : String(v)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
            var _fullName = (m.name && m.name !== m.login) ? m.name : '';
            var _titleHtml = _fullName
                ? (_h(_fullName) + ' <span style="font-weight:400;color:#64748b;">(' + _h(m.login) + ')</span>')
                : (_h(m.login) + ' <span style="font-weight:400;color:#94a3b8;font-style:italic;">(name n/a)</span>');
            html += '<div style="display:flex;justify-content:space-between;align-items:center;"><span class="mm-item-name">' + _titleHtml + '</span>';
            html += '<span style="display:flex;align-items:center;gap:6px;">';
            if (hasElevate) {
                html += '<span class="mm-err-btn" data-err-login="' + m.login + '" data-err-name="' + (m.name || '').replace(/"/g, '&quot;') + '">\uD83D\uDCCB ' + (errCount > 0 ? errCount + ' Errors' : 'View Errors') + '</span>';
            }
            html += '<span style="font-size:10px;color:#64748b;">' + visibleAlerts.length + ' coaching' + (visibleAlerts.length > 1 ? 's' : '') + '</span></span></div>';
            html += '<div class="mm-item-alerts">';
            for (var a = 0; a < visibleAlerts.length; a++) {
                var acfg = getTypeConfig(visibleAlerts[a].type);
                if (visibleAlerts[a].type === 'ELEV') {
                    html += '<span class="mm-badge" style="background:' + acfg.bg + ';">' + visibleAlerts[a].metric + '</span>';
                    html += claimIndicatorHTML(m.login, visibleAlerts[a].metric);
                    if (visibleAlerts[a].formURL) {
                        html += '<a class="mm-elevate-link" data-login="' + m.login + '" data-metric="' + visibleAlerts[a].metric + '" data-url="' + visibleAlerts[a].formURL + '">Open Form</a>';
                    }
                } else if (visibleAlerts[a].type === 'POS') {
                    html += '<span class="mm-badge" style="background:' + acfg.bg + ';">\u2B50 ' + (visibleAlerts[a].metric || 'Positive Reinforcement') + '</span>';
                    if (visibleAlerts[a].formURL) {
                        html += '<a class="mm-elevate-link" data-login="' + m.login + '" data-metric="' + visibleAlerts[a].metric + '" data-url="' + visibleAlerts[a].formURL + '">Open Form</a>';
                    }
                    // Show positive coaching details inline
                    var posDetails = [];
                    if (visibleAlerts[a].ibUPH) posDetails.push('IB UPH: ' + visibleAlerts[a].ibUPH);
                    if (visibleAlerts[a].obUPH) posDetails.push('OB UPH: ' + visibleAlerts[a].obUPH);
                    if (posDetails.length > 0) {
                        html += '<div style="font-size:9px;color:#065f46;margin-top:2px;">' + posDetails.join(' \u2022 ') + '</div>';
                    }
                } else {
                    html += '<span class="mm-badge" style="background:' + acfg.bg + ';">' + visibleAlerts[a].count + 'x ' + acfg.label + ' \u2022 ' + visibleAlerts[a].date + '</span>';
                }
            }
            html += '</div>';
            html += '<div class="mm-item-detail">Login: <span class="mm-login-copy" style="cursor:pointer;border-bottom:1px dashed #94a3b8;" title="Click to copy">' + m.login + '</span> \u2022 Mgr: ' + m.manager + (m.shift ? ' \u2022 ' + m.shift : '') + '</div>';
            } // end expanded card body (v41.14)
            html += '</div>';
        }
        html += '</div>';

        // Recently Completed section — shows items that can be un-completed
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var completedKeys = Object.keys(completed);
        if (completedKeys.length > 0) {
            // Sort by most recently completed first
            completedKeys.sort(function(a, b) {
                var aVal = completed[a], bVal = completed[b];
                var aTime = (typeof aVal === 'object') ? aVal.timestamp : aVal;
                var bTime = (typeof bVal === 'object') ? bVal.timestamp : bVal;
                return (bTime || 0) - (aTime || 0);
            });
            html += '<div style="margin:12px 14px 8px;"><button id="mm-toggle-completed" style="background:none;border:none;color:#94a3b8;font-size:10px;cursor:pointer;padding:2px 0;font-weight:600;">\u25B6 Recently Completed (' + completedKeys.length + ')</button></div>';
            html += '<div id="mm-completed-section" style="display:none;padding:0 14px 14px;">';
            for (var ci = 0; ci < completedKeys.length; ci++) {
                var cKey = completedKeys[ci];
                var cParts = cKey.split('|');
                var cLogin = cParts[0];
                var cMetric = cParts.slice(1).join('|');
                var cVal = completed[cKey];
                var cTime = (typeof cVal === 'object') ? cVal.timestamp : cVal;
                var cBy = (typeof cVal === 'object' && cVal.completedBy) ? cVal.completedBy : 'unknown';
                var cAgo = cTime ? Math.round((Date.now() - cTime) / 60000) : 0;
                var cAgoStr = cAgo < 60 ? cAgo + 'min ago' : Math.round(cAgo / 60) + 'h ago';
                html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;margin-bottom:4px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">';
                html += '<div style="flex:1;"><span style="font-weight:700;font-size:12px;color:#166534;">' + cLogin + '</span> <span style="font-size:11px;color:#475569;">\u2022 ' + cMetric + '</span><div style="font-size:10px;color:#94a3b8;margin-top:2px;">\u2705 Completed ' + cAgoStr + ' by <strong style="color:#1e293b;">' + cBy + '</strong></div></div>';
                html += '<button class="mm-uncomplete-btn" data-login="' + cLogin + '" data-metric="' + cMetric.replace(/"/g, '&quot;') + '" style="background:#dc2626;color:#fff;border:none;border-radius:6px;padding:5px 10px;font-size:10px;font-weight:700;cursor:pointer;white-space:nowrap;transition:background 0.15s;" title="Restore this item so it shows up for everyone again">\u21A9 Mark Not Completed</button>';
                html += '</div>';
            }
            html += '</div>';
        }

        content.innerHTML = html;
        attachUploadHandlers();
        // v37: attach the dashboard filter delegated listener ONCE (survives innerHTML re-renders
        // because it lives on the persistent #mm-content parent, reading data-filter off clicked tiles/pills).
                // v41.42: removed orphaned Copy Remaining handler (button was removed in v41.37).

        // Click-to-copy for login/manager spans
        content.querySelectorAll('.mm-login-copy').forEach(function(span) {
            span.addEventListener('click', function(e) {
                e.stopPropagation();
                var orig = span.textContent.trim();
                navigator.clipboard.writeText(orig);
                span.textContent = '\u2713 Copied';
                span.style.color = '#067D62';
                setTimeout(function() { span.textContent = orig; span.style.color = ''; }, 800);
            });
        });

        // Filter click handlers
        content.querySelectorAll('.mm-type-pill[data-filter]').forEach(function(pill) {
            pill.addEventListener('click', function() {
                var f = pill.dataset.filter;
                if (f === 'ALL') { activeFilters = []; activeElevMetric = []; }
                else {
                    var idx = activeFilters.indexOf(f);
                    if (idx >= 0) { activeFilters.splice(idx, 1); }
                    else { activeFilters.push(f); }
                    if (f !== 'ELEV') activeElevMetric = [];
                }
                updatePanel();
            });
        });

        // Elevate metric sub-filter click handlers
        content.querySelectorAll('.mm-type-pill[data-elevmetric]').forEach(function(pill) {
            pill.addEventListener('click', function() {
                var em = pill.dataset.elevmetric;
                if (em === 'ALL') { activeElevMetric = []; }
                else {
                    var idx = activeElevMetric.indexOf(em);
                    if (idx >= 0) { activeElevMetric.splice(idx, 1); }
                    else { activeElevMetric.push(em); }
                }
                updatePanel();
            });
        });

        // Hide type toggle handlers
        content.querySelectorAll('.mm-hide-toggle').forEach(function(pill) {
            pill.addEventListener('click', function() {
                var type = pill.dataset.hidetype;
                var idx = hiddenTypes.indexOf(type);
                if (idx >= 0) { hiddenTypes.splice(idx, 1); }
                else { hiddenTypes.push(type); }
                GM_setValue('hiddenTypes', JSON.stringify(hiddenTypes));
                matchAndAlert();
            });
        });

        // Search handler
        var searchInput = document.getElementById('mm-search');
        if (searchInput) {
            searchInput.addEventListener('input', function() { activeSearch = this.value; updatePanel(); });
            searchInput.focus();
            searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
        }
        // Sort handler
        var sortSelect = document.getElementById('mm-sort');
        if (sortSelect) sortSelect.addEventListener('change', function() { activeSort = this.value; updatePanel(); });

        // Recently Completed toggle and Mark Not Completed handlers
        var toggleCompleted = document.getElementById('mm-toggle-completed');
        if (toggleCompleted) toggleCompleted.addEventListener('click', function() {
            var section = document.getElementById('mm-completed-section');
            if (section) {
                var hidden = section.style.display === 'none';
                section.style.display = hidden ? '' : 'none';
                toggleCompleted.textContent = (hidden ? '\u25BC' : '\u25B6') + ' Recently Completed (' + Object.keys(JSON.parse(GM_getValue('elevateCompleted', '{}'))).length + ')';
            }
        });
        content.querySelectorAll('.mm-uncomplete-btn').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                var login = btn.dataset.login;
                var metric = btn.dataset.metric;
                btn.textContent = '\u21A9 Restoring...';
                btn.disabled = true;
                btn.style.background = '#94a3b8';
                markNotCompleted(login, metric);
            });
        });

        // Error details button handlers in panel
        content.querySelectorAll('.mm-err-btn[data-err-login]').forEach(function(btn) {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                showErrDetailsPopup(btn.dataset.errLogin, btn.dataset.errName, btn);
            });
        });

        // Open Form link handlers
        content.querySelectorAll('.mm-elevate-link').forEach(function(link) {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                var login = link.dataset.login;
                var metric = link.dataset.metric;
                var url = link.dataset.url;
                var pending = JSON.parse(GM_getValue('elevatePending', '{}'));

                // If already pending, this click is to confirm submission
                if (pending[login + '|' + metric]) {
                    showElevateConfirm(login, metric, function() {
                        var leader = getLeaderLogin();
                        if (!leader) return; // Don't complete if no leader login
                        var p = JSON.parse(GM_getValue('elevatePending', '{}'));
                        delete p[login + '|' + metric];
                        GM_setValue('elevatePending', JSON.stringify(p));
                        // Log the completion — single source of truth
                        addToCoachingLog(login, metric, leader, 'completed');
                        matchAndAlert();
                    }, function() {
                        // No — reset link to original, clear pending
                        var p = JSON.parse(GM_getValue('elevatePending', '{}'));
                        delete p[login + '|' + metric];
                        GM_setValue('elevatePending', JSON.stringify(p));
                        link.style.color = '#dc2626';
                        link.textContent = 'Open Form';
                    });
                    return;
                }
                // First click: open form, mark as pending
                navigator.clipboard.writeText(login).then(function() {
                    var toast = document.createElement('div');
                    toast.textContent = '\u2705 "' + login + '" copied \u2014 Ctrl+V into Alias field. Click "Open Form" again after submitting to mark complete.';
                    toast.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e293b;color:#fff;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;z-index:999999;box-shadow:0 4px 12px rgba(0,0,0,0.4);border:1px solid #334155;max-width:500px;text-align:center;';
                    document.body.appendChild(toast);
                    setTimeout(function() { toast.remove(); }, 5000);
                    pending[login + '|' + metric] = Date.now();
                    GM_setValue('elevatePending', JSON.stringify(pending));
                    link.style.color = '#f59e0b';
                    link.textContent = '\u2705 Mark Submitted';
                    // Add inline "Not Completed" button next to the link
                    var existingUndo = link.parentNode.querySelector('.mm-undo-inline');
                    if (!existingUndo) {
                        var undoBtn2 = document.createElement('span');
                        undoBtn2.className = 'mm-undo-inline';
                        undoBtn2.textContent = '\u21A9 Mark Not Completed';
                        undoBtn2.style.cssText = 'display:inline-block;font-size:10px;color:#fff;background:#dc2626;padding:2px 8px;border-radius:6px;cursor:pointer;margin-left:6px;font-weight:600;transition:background 0.15s;';
                        undoBtn2.title = 'Cancel submission — restore this item for everyone';
                        undoBtn2.addEventListener('mouseenter', function() { undoBtn2.style.background = '#b91c1c'; });
                        undoBtn2.addEventListener('mouseleave', function() { undoBtn2.style.background = '#dc2626'; });
                        undoBtn2.addEventListener('click', (function(uLogin, uMetric, uLink, uBtn) { return function(ev) {
                            ev.stopPropagation();
                            ev.preventDefault();
                            var p2 = JSON.parse(GM_getValue('elevatePending', '{}'));
                            delete p2[uLogin + '|' + uMetric];
                            GM_setValue('elevatePending', JSON.stringify(p2));
                            uLink.style.color = '#dc2626';
                            uLink.textContent = 'Open Form';
                            uBtn.remove();
                        }; })(login, metric, link, undoBtn2));
                        link.parentNode.insertBefore(undoBtn2, link.nextSibling);
                    }
                    window.open(url, '_blank');
                });
            });
            // If already pending, update link appearance and add inline "Not Completed" button
            var pending = JSON.parse(GM_getValue('elevatePending', '{}'));
            if (pending[link.dataset.login + '|' + link.dataset.metric]) {
                link.style.color = '#f59e0b';
                link.textContent = '\u2705 Mark Submitted';
                // Add inline "Not Completed" button next to it
                var undoBtn = document.createElement('span');
                undoBtn.textContent = '\u21A9 Mark Not Completed';
                undoBtn.style.cssText = 'display:inline-block;font-size:10px;color:#fff;background:#dc2626;padding:2px 8px;border-radius:6px;cursor:pointer;margin-left:6px;font-weight:600;transition:background 0.15s;';
                undoBtn.title = 'Cancel submission — restore this item for everyone';
                undoBtn.addEventListener('mouseenter', function() { undoBtn.style.background = '#b91c1c'; });
                undoBtn.addEventListener('mouseleave', function() { undoBtn.style.background = '#dc2626'; });
                undoBtn.addEventListener('click', (function(uLogin, uMetric, uLink, uUndoBtn) { return function(e) {
                    e.stopPropagation();
                    e.preventDefault();
                    // Clear pending state
                    var p = JSON.parse(GM_getValue('elevatePending', '{}'));
                    delete p[uLogin + '|' + uMetric];
                    GM_setValue('elevatePending', JSON.stringify(p));
                    // Reset link back to normal
                    uLink.style.color = '#dc2626';
                    uLink.textContent = 'Open Form';
                    // Remove the undo button
                    uUndoBtn.remove();
                }; })(link.dataset.login, link.dataset.metric, link, undoBtn));
                link.parentNode.insertBefore(undoBtn, link.nextSibling);
            }
        });
    }

    function attachUploadHandlers() {
        // Toggle data sources visibility
        var toggleBtn = document.getElementById('mm-toggle-data');
        if (toggleBtn) toggleBtn.addEventListener('click', function() {
            var section = document.getElementById('mm-data-section');
            if (section) {
                var hidden = section.style.display === 'none';
                section.style.display = hidden ? '' : 'none';
                toggleBtn.textContent = hidden ? '\u25BC Hide Data Sources' : '\u25B6 Show Data Sources';
                GM_setValue('mm_data_hidden', !hidden);
            }
        });

        // Toggle coaching log visibility
        var toggleLogBtn = document.getElementById('mm-toggle-log');
        if (toggleLogBtn) toggleLogBtn.addEventListener('click', function() {
            var section = document.getElementById('mm-log-section');
            if (section) {
                var hidden = section.style.display === 'none';
                section.style.display = hidden ? '' : 'none';
                toggleLogBtn.textContent = (hidden ? '\u25BC' : '\u25B6') + ' Coaching Log (' + coachingLog.length + ')';
                GM_setValue('mm_log_hidden', !hidden);
            }
        });

        // Toggle hide types visibility
        var toggleHideBtn = document.getElementById('mm-toggle-hide');
        if (toggleHideBtn) toggleHideBtn.addEventListener('click', function() {
            var section = document.getElementById('mm-hide-section');
            if (section) {
                var hidden = section.style.display === 'none';
                section.style.display = hidden ? '' : 'none';
                toggleHideBtn.textContent = (hidden ? '\u25BC' : '\u25B6') + ' Hide Coachings';
                GM_setValue('mm_hide_hidden', !hidden);
            }
        });

        // Toggle coaching summary visibility
        var toggleSummaryBtn = document.getElementById('mm-toggle-summary');
        if (toggleSummaryBtn) toggleSummaryBtn.addEventListener('click', function() {
            var section = document.getElementById('mm-summary-section');
            if (section) {
                var hidden = section.style.display === 'none';
                section.style.display = hidden ? '' : 'none';
                toggleSummaryBtn.textContent = (hidden ? '\u25BC' : '\u25B6') + ' Coaching Summary';
                GM_setValue('mm_summary_hidden', !hidden);
            }
        });

        // Clear Week button — resets coaching log and summary for everyone
        var clearSummaryBtn = document.getElementById('mm-clear-summary');
        if (clearSummaryBtn) clearSummaryBtn.addEventListener('click', async function() {
            if (!confirm('Clear the coaching summary and log for ALL users?\n\nThis will archive the current log and reset everyone\'s counts to 0.\n\nUse this at the start of a new week.')) return;
            clearSummaryBtn.textContent = '\u23F3 Clearing...';
            clearSummaryBtn.disabled = true;
            // Archive before clearing
            if (coachingLog.length > 0) {
                var weekStart = new Date();
                weekStart.setDate(weekStart.getDate() - weekStart.getDay());
                var weekStr = (weekStart.getMonth()+1) + '-' + weekStart.getDate() + '-' + weekStart.getFullYear();
                try { await firebaseRequest('archives/coaching_log_week_' + weekStr, 'PUT', { log: coachingLog, archivedAt: Date.now(), weekOf: weekStr }); } catch(e) {}
            }
            // Reset
            coachingLog = [];
            var newResetId = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
            GM_setValue('coachingLog', JSON.stringify(coachingLog));
            GM_setValue('coachingLogResetId', newResetId);
            buildCompletedFromLog();
            await pushCoachingLogToFirebase(true);
            // Also clear previous week error details (local + Firebase)
            coachingErrDetails = {};
            GM_setValue('coachingErrDetails', JSON.stringify(coachingErrDetails));
            GM_setValue('errDetailsTimestamp', 0);
            try { await firebaseRequest('errdetails', 'PUT', { data: {}, timestamp: Date.now() }); } catch(e) {}
            console.log('[CoachTracker] Coaching log and error details cleared manually (resetId: ' + newResetId + ')');
            if (engageEmployees.length > 0 && dataLoaded) matchAndAlert();
            else updatePanel();
        });

        // Elevate CSV upload
        var drop = document.getElementById('mm-elevate-drop');
        var fileInput = document.getElementById('mm-elevate-file');
        if (drop && fileInput) {
            drop.addEventListener('click', function() { fileInput.click(); });
            drop.addEventListener('dragover', function(e) { e.preventDefault(); drop.style.background = '#ffeeba'; });
            drop.addEventListener('dragleave', function() { drop.style.background = ''; });
            drop.addEventListener('drop', function(e) {
                e.preventDefault(); drop.style.background = '';
                var file = e.dataTransfer.files[0];
                if (file) readCSVFile(file);
            });
            fileInput.addEventListener('change', function() {
                if (fileInput.files[0]) readCSVFile(fileInput.files[0]);
            });
        }

        // Manual complete — lookup button shows metrics for a login as checkboxes
        var manualLookupBtn = document.getElementById('mm-manual-lookup-btn');
        if (manualLookupBtn) manualLookupBtn.addEventListener('click', function() {
            var loginInp = document.getElementById('mm-manual-login');
            var resultsDiv = document.getElementById('mm-manual-results');
            var rawInput = loginInp ? loginInp.value.trim() : '';
            if (!rawInput) { alert('Paste login + metric pairs (tab-separated) or just logins.'); return; }
            if (!resultsDiv) return;

            // Parse input: each line can be "login\tmetric" (from spreadsheet) or just "login"
            // Smart detection: if col1 looks like a metric name (has spaces/known keywords), swap columns
            var lines = rawInput.split(/\n/).filter(function(l) { return l.trim().length > 0; });
            var pairs = []; // { login, metric } — specific pairs to show
            var loginsOnly = []; // logins without a metric — show all their metrics

            // Known metric keywords to detect if columns are swapped
            var metricKeywords = ['item quality', 'missing items', 'first pass yield', 'ib receive', 'combined cycle', 'false pick', 'learning curve', 'pond', 'safety', 'tot'];

            function looksLikeMetric(str) {
                var lower = str.toLowerCase();
                if (lower.indexOf(' ') !== -1) return true; // Metrics have spaces, logins don't
                for (var k = 0; k < metricKeywords.length; k++) {
                    if (lower.indexOf(metricKeywords[k]) !== -1) return true;
                }
                return false;
            }

            for (var li = 0; li < lines.length; li++) {
                var parts = lines[li].split('\t');
                var col1 = (parts[0] || '').trim();
                var col2 = parts.length > 1 ? parts[1].trim() : '';
                if (!col1) continue;
                if (col2) {
                    // Two columns — detect which is login vs metric
                    var login, metric;
                    if (looksLikeMetric(col1) && !looksLikeMetric(col2)) {
                        // Columns are swapped: metric is first, login is second
                        metric = col1;
                        login = col2.toLowerCase();
                    } else {
                        // Normal order: login first, metric second
                        login = col1.toLowerCase();
                        metric = col2;
                    }
                    pairs.push({ login: login, metric: metric });
                } else {
                    // Single column — could be comma-separated logins
                    var subLogins = col1.toLowerCase().split(/[,\s]+/).filter(function(s) { return s.length > 0; });
                    subLogins.forEach(function(sl) { loginsOnly.push(sl); });
                }
            }

            var html = '';
            var foundAny = false;
            var notFound = [];

            // Show specific login+metric pairs as checkboxes
            if (pairs.length > 0) {
                html += '<div style="margin-bottom:6px;padding:6px 8px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;">';
                html += '<div style="font-size:10px;color:#475569;font-weight:700;margin-bottom:3px;">' + pairs.length + ' coaching pair' + (pairs.length > 1 ? 's' : '') + ' pasted:</div>';
                for (var pi = 0; pi < pairs.length; pi++) {
                    var p = pairs[pi];
                    var alreadyDone = isElevateCompleted(p.login, p.metric);
                    var inList = elevateByLogin[p.login] && elevateByLogin[p.login].some(function(m) { return m.metric === p.metric; });
                    if (!inList && !alreadyDone) {
                        // Not in elevate list — still allow marking but flag it
                        html += '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px;color:#92400e;cursor:pointer;">';
                        html += '<input type="checkbox" class="mm-manual-chk" data-login="' + p.login + '" data-metric="' + p.metric.replace(/"/g, '&quot;') + '" style="accent-color:#f59e0b;">';
                        html += '<span><strong>' + p.login + '</strong> \u2022 ' + p.metric + ' <em style="font-size:9px;">(not in elevate list)</em></span></label>';
                    } else {
                        html += '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px;color:' + (alreadyDone ? '#16a34a' : '#1e293b') + ';cursor:pointer;">';
                        html += '<input type="checkbox" class="mm-manual-chk" data-login="' + p.login + '" data-metric="' + p.metric.replace(/"/g, '&quot;') + '" ' + (alreadyDone ? 'checked disabled' : '') + ' style="accent-color:#16a34a;">';
                        html += '<span><strong>' + p.login + '</strong> \u2022 ' + p.metric + (alreadyDone ? ' <em style="color:#16a34a;font-size:9px;">(done)</em>' : '') + '</span></label>';
                    }
                    foundAny = true;
                }
                html += '</div>';
            }

            // Show all metrics for logins-only entries
            for (var loi = 0; loi < loginsOnly.length; loi++) {
                var login = loginsOnly[loi];
                var metrics = elevateByLogin[login];
                if (!metrics || metrics.length === 0) {
                    notFound.push(login);
                    continue;
                }
                foundAny = true;
                html += '<div style="margin-bottom:6px;padding:6px 8px;background:#fff;border:1px solid #e2e8f0;border-radius:6px;">';
                html += '<div style="font-size:10px;color:#475569;font-weight:700;margin-bottom:3px;">' + login + ' <span style="color:#94a3b8;font-weight:400;">(' + metrics.length + ' coaching' + (metrics.length > 1 ? 's' : '') + ')</span></div>';
                for (var mi = 0; mi < metrics.length; mi++) {
                    var m = metrics[mi];
                    var metricName = m.metric || 'Unknown';
                    var alreadyDone2 = isElevateCompleted(login, metricName);
                    html += '<label style="display:flex;align-items:center;gap:6px;padding:2px 0;font-size:11px;color:' + (alreadyDone2 ? '#16a34a' : '#1e293b') + ';cursor:pointer;">';
                    html += '<input type="checkbox" class="mm-manual-chk" data-login="' + login + '" data-metric="' + metricName.replace(/"/g, '&quot;') + '" ' + (alreadyDone2 ? 'checked disabled' : '') + ' style="accent-color:#16a34a;">';
                    html += '<span>' + metricName + (alreadyDone2 ? ' <em style="color:#16a34a;font-size:9px;">(done)</em>' : '') + '</span></label>';
                }
                html += '</div>';
            }

            if (notFound.length > 0) {
                html += '<div style="font-size:10px;color:#dc2626;padding:4px 0;">\u274C Not found in elevate list: <strong>' + notFound.join(', ') + '</strong></div>';
            }

            if (foundAny) {
                // Select All / Submit buttons
                html += '<div style="display:flex;gap:6px;margin-top:6px;align-items:center;">';
                html += '<button id="mm-manual-selall" style="padding:4px 10px;background:#475569;color:#fff;border:none;border-radius:5px;font-size:10px;font-weight:700;cursor:pointer;">Select All Pending</button>';
                html += '<button id="mm-manual-submit" style="padding:5px 12px;background:#16a34a;color:#fff;border:none;border-radius:5px;font-size:11px;font-weight:700;cursor:pointer;">\u2705 Mark Selected Complete</button>';
                html += '</div>';
            }

            resultsDiv.innerHTML = html;

            // Select All handler
            var selAllBtn = document.getElementById('mm-manual-selall');
            if (selAllBtn) selAllBtn.addEventListener('click', function() {
                resultsDiv.querySelectorAll('.mm-manual-chk:not(:disabled)').forEach(function(chk) { chk.checked = true; });
            });

            // Submit handler — does NOT rebuild panel, just updates in-place
            var submitBtn = document.getElementById('mm-manual-submit');
            if (submitBtn) submitBtn.addEventListener('click', function() {
                var checks = resultsDiv.querySelectorAll('.mm-manual-chk:checked:not(:disabled)');
                if (checks.length === 0) { alert('Check at least one item to complete.'); return; }
                var leaderLogin = getLeaderLogin();
                if (!leaderLogin) return;
                for (var ci = 0; ci < checks.length; ci++) {
                    var chk = checks[ci];
                    addToCoachingLog(chk.getAttribute('data-login'), chk.getAttribute('data-metric'), leaderLogin, 'completed');
                    // Mark as done in-place without rebuilding panel
                    chk.checked = true;
                    chk.disabled = true;
                    var label = chk.closest('label');
                    if (label) { label.style.color = '#16a34a'; label.querySelector('span').innerHTML += ' <em style="color:#16a34a;font-size:9px;">(done)</em>'; }
                }
                submitBtn.textContent = '\u2705 Logged ' + checks.length + '!';
                submitBtn.style.background = '#065f46';
                // Clear input and refocus for next batch — no panel rebuild
                setTimeout(function() {
                    if (loginInp) { loginInp.value = ''; loginInp.focus(); }
                    submitBtn.textContent = '\u2705 Mark Selected Complete';
                    submitBtn.style.background = '#16a34a';
                }, 1200);
            });
        });
        // Also trigger lookup on Enter key in login input (Ctrl+Enter for textarea)
        var manualLoginInp = document.getElementById('mm-manual-login');
        if (manualLoginInp) manualLoginInp.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (manualLookupBtn) manualLookupBtn.click(); }
        });

        // Site code change
        var siteChange = document.getElementById('mm-site-change');
        if (siteChange) siteChange.addEventListener('click', function() {
            var code = prompt('Enter site code (e.g., UNJ2, UFL6):', ELEVATE_SITE_CODE);
            if (code && code.trim().length >= 3) {
                code = code.trim().toUpperCase();
                GM_setValue('elevate_site_code', code);
                ELEVATE_SITE_CODE = code;
                console.log('[CoachTracker] Site changed to: ' + code);
                pullElevateFromFirebase();
                updatePanel();
            }
        });

        // Fetch errors button — fetch from Firebase
        var fetchBtn = document.getElementById('mm-fetch-errors');
        if (fetchBtn) fetchBtn.addEventListener('click', function() {
            fetchBtn.textContent = 'Fetching...';
            fetchBtn.disabled = true;
            firebaseRequest('errdetails', 'GET').then(function(payload) {
                if (payload && payload.data) {
                    coachingErrDetails = payload.data;
                    GM_setValue('coachingErrDetails', JSON.stringify(coachingErrDetails));
                    GM_setValue('errDetailsTimestamp', payload.timestamp || Date.now());
                    console.log('[CoachTracker] Fetched Error Details from Firebase (' + Object.keys(coachingErrDetails).length + ' associates)');
                    if (engageEmployees.length > 0) matchAndAlert();
                    else updatePanel();
                } else {
                    fetchBtn.textContent = 'No data';
                    setTimeout(function() { fetchBtn.textContent = 'Fetch'; fetchBtn.disabled = false; }, 2000);
                }
            }).catch(function(e) {
                console.error('[CoachTracker] Fetch error:', e.message);
                fetchBtn.textContent = 'Failed';
                setTimeout(function() { fetchBtn.textContent = 'Fetch'; fetchBtn.disabled = false; }, 2000);
            });
        });

        // Fetch positive coachings button — fetch from Firebase
        var fetchPosBtn = document.getElementById('mm-fetch-positive');
        if (fetchPosBtn) fetchPosBtn.addEventListener('click', function() {
            fetchPosBtn.textContent = 'Fetching...';
            fetchPosBtn.disabled = true;
            firebaseRequest('positive_coachings', 'GET').then(function(payload) {
                if (payload && payload.data) {
                    positiveByLogin = payload.data;
                    GM_setValue('positiveData', JSON.stringify(positiveByLogin));
                    GM_setValue('positiveTimestamp', payload.timestamp || Date.now());
                    console.log('[CoachTracker] Fetched Positive Coachings from Firebase (' + Object.keys(positiveByLogin).length + ' associates)');
                    if (engageEmployees.length > 0) matchAndAlert();
                    else updatePanel();
                } else {
                    fetchPosBtn.textContent = 'No data';
                    setTimeout(function() { fetchPosBtn.textContent = 'Fetch'; fetchPosBtn.disabled = false; }, 2000);
                }
            }).catch(function(e) {
                console.error('[CoachTracker] Positive coaching fetch error:', e.message);
                fetchPosBtn.textContent = 'Failed';
                setTimeout(function() { fetchPosBtn.textContent = 'Fetch'; fetchPosBtn.disabled = false; }, 2000);
            });
        });

        // Leader login set/change/save handlers
        var leaderSetBtn = document.getElementById('mm-leader-set');
        var leaderChangeBtn = document.getElementById('mm-leader-change');
        if (leaderSetBtn) leaderSetBtn.addEventListener('click', function() {
            var sec = document.getElementById('mm-leader-section');
            if (sec) sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
        });
        if (leaderChangeBtn) leaderChangeBtn.addEventListener('click', function() {
            var sec = document.getElementById('mm-leader-section');
            if (sec) sec.style.display = sec.style.display === 'none' ? 'block' : 'none';
        });
        var leaderSaveBtn = document.getElementById('mm-leader-save');
        if (leaderSaveBtn) leaderSaveBtn.addEventListener('click', function() {
            var inp = document.getElementById('mm-leader-input');
            var val = inp ? inp.value.trim().toLowerCase() : '';
            if (!val || val.length < 3) { alert('Please enter a valid login (at least 3 characters)'); return; }
            GM_setValue('leader_login', val);
            leaderSaveBtn.textContent = '\u2705 Saved!';
            setTimeout(function() { updatePanel(); }, 800);
        });
    }

    function readCSVFile(file) {
        var reader = new FileReader();
        reader.onload = async function(e) {
            var count = parseElevateCSV(e.target.result);
            if (count === -1) {
                alert('CSV missing required columns (Associate ID, Submitted by). Make sure you exported from the Elevate QuickSight dashboard.');
            } else {
                // Archive current coaching log to Firebase before updating
                if (coachingLog.length > 0) {
                    var weekStart = new Date();
                    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
                    var weekStr = (weekStart.getMonth()+1) + '-' + weekStart.getDate() + '-' + weekStart.getFullYear();
                    try {
                        await firebaseRequest('archives/coaching_log_week_' + weekStr, 'PUT', { log: coachingLog, archivedAt: Date.now(), weekOf: weekStr });
                        console.log('[CoachTracker] Archived coaching log to Firebase: week_' + weekStr);
                    } catch(archErr) { console.error('[CoachTracker] Archive failed:', archErr.message); }
                }

                // DO NOT reset coaching log on CSV upload — summary persists
                buildCompletedFromLog();

                if (engageEmployees.length > 0) matchAndAlert();
                else updatePanel();
                var drop = document.getElementById('mm-elevate-drop');
                if (drop) { drop.className = 'mm-elevate-upload loaded'; drop.childNodes[0].textContent = '\u2705 Uploading to Firebase...'; }
                var ok = await pushElevateToFirebase(true);
                if (drop) {
                    drop.childNodes[0].textContent = ok
                        ? '\u2705 ' + Object.keys(elevateByLogin).length + ' associates synced to all users (' + count + ' need coaching)'
                        : '\u2705 ' + Object.keys(elevateByLogin).length + ' loaded locally (' + count + ' need coaching) \u2014 Firebase sync failed';
                }
                await pushCoachingLogToFirebase();
            }
        };
        reader.readAsText(file);
    }

    // NEW: Read error details CSV file



    // ============================================================
    // === v39: FIND PEOPLE — LIVE ON-SITE SOURCE (STORM) =========
    // ============================================================
    // Confirmed live 2026-09-23: Find People exposes a clean JSON API
    //   GET https://na.store-management.f3.amazon.dev/api/v1/labortracking/findpeople/{siteId}
    //   -> { associates: [ { associateId, function, zone, lastLocation, ... }, ... ] }
    // associateId = the login. This is the real-time on-site roster (who is clocked in now).
    // We capture {siteId} by intercepting the page's own call, then poll the API for freshness.
    var FP_API_BASE = 'https://na.store-management.f3.amazon.dev/api/v1/labortracking/findpeople/';
    // v41.1: known Find People site IDs so a site works IMMEDIATELY without the one-time
    // Find People visit. UNJ2 confirmed live 2026-09-23. Other sites auto-capture on first FP visit.
    var FP_KNOWN_SITE_IDS = { 'UNJ2': '35fbfe04-3056-42e2-b717-e414a5655105' };
    var fpSiteId = GM_getValue('fp_site_id', '')
        || (FP_KNOWN_SITE_IDS[GM_getValue('elevate_site_code','') || ''] || '');   // captured, or known-map fallback
    var onSiteLogins = {};                          // login -> true (currently on site)
    var onSiteCount = 0;
    var fpLastUpdate = 0;
    var fpRosterSource = '';   // v41.10: 'api' (authoritative) | 'dom' (fallback) | '' (none yet)

    // Intercept the page's Find People API call to learn the siteId (per-site, no hardcoding).
    // v39.4: proactively recover the siteId even if the page's API call fired BEFORE our hook
    // installed — scan the browser's performance resource timing for the findpeople URL. This makes
    // the accurate API path (not the fragile DOM scrape) work reliably, fixing the on-site over-count.
    function fpRecoverSiteIdFromPerf() {
        try {
            var entries = (performance.getEntriesByType ? performance.getEntriesByType('resource') : []) || [];
            for (var i = entries.length - 1; i >= 0; i--) {
                var m = (entries[i].name || '').match(/\/labortracking\/findpeople\/([0-9a-f-]{36})/i);
                if (m && m[1]) { if (m[1] !== fpSiteId) { fpSiteId = m[1]; GM_setValue('fp_site_id', fpSiteId); console.log('[CoachTracker][FP] siteId recovered from perf: ' + fpSiteId); } return fpSiteId; }
            }
        } catch(e) {}
        return fpSiteId;
    }

    function fpInterceptSiteId() {
        fpRecoverSiteIdFromPerf();
        var origFetch = window.fetch;
        window.fetch = function() {
            var args = arguments;
            var url = (typeof args[0] === 'string') ? args[0] : (args[0] && args[0].url) || '';
            var m = url.match(/\/labortracking\/findpeople\/([0-9a-f-]{36})/i);
            if (m && m[1] && m[1] !== fpSiteId) {
                fpSiteId = m[1];
                GM_setValue('fp_site_id', fpSiteId);
                console.log('[CoachTracker][FP] site id captured: ' + fpSiteId);
            }
            return origFetch.apply(this, args).then(function(resp){
                try {
                    if (/\/labortracking\/findpeople\//i.test(url)) {
                        resp.clone().json().then(function(j){ fpApplyRoster(j); }).catch(function(){});
                    }
                } catch(e) {}
                return resp;
            });
        };
    }

    // Parse a Find People API payload into the on-site login set.
    function fpApplyRoster(j) {
        var arr = j && j.associates ? j.associates : (Array.isArray(j) ? j : null);
        if (!arr) return;
        var next = {};
        var excluded = 0;
        // v42.5 EXCLUDE PUNCHED-OUT AAs. Find People still LISTS associates who punched out / ended
        // shift (their process = 'PunchOut' or 'PunchOut/EOS'). Those are NOT on-site — including them
        // violated the on-site rule (a clocked-out AA got flagged). Skip any associate whose function
        // or sub-process indicates PunchOut/EOS. Check several possible field names defensively.
        function isPunchedOut(pp){
            var vals = [pp.function, pp.subProcess, pp.subProcessPath, pp.subprocess, pp.processPath, pp.lastEvent, pp.process, pp.status]
                .map(function(v){ return (v == null ? '' : String(v)).toLowerCase(); }).join(' | ');
            return /punch\s*out|punchout|\beos\b|end of shift|clocked out|clock out/.test(vals);
        }
        arr.forEach(function(pp){
            var id = (pp.associateId || '').trim().toLowerCase();
            if (!id) return;
            if (isPunchedOut(pp)) { excluded++; return; }   // punched out -> NOT on site
            next[id] = true;
        });
        onSiteLogins = next;
        onSiteCount = Object.keys(next).length;
        fpLastUpdate = Date.now();
        fpRosterSource = 'api';   // v41.10: API is authoritative — the exact Find People on-site set.
        console.log('[CoachTracker][FP] on-site roster: ' + onSiteCount + ' on site (' + excluded + ' punched-out excluded)');
        if (typeof matchAndAlert === 'function') matchAndAlert();
    }

    // Actively pull the roster (in case the page hasn't fired its own call recently).
    // v39.1: DOM-scrape fallback — read the on-site logins straight from the Find People table
    // (TABLE.sc-... > tbody > tr, first cell = associateId). Used when the API siteId wasn't
    // captured (e.g. the page fired its API call before our interceptor installed). The table
    // is already rendered with the live roster, so this is reliable and needs no siteId.
    // v41.42: removed unused fpScrapeRosterFromDOM() — never called (API roster is authoritative).


    function fpFetchRoster() {
        if (!fpSiteId) { console.warn('[CoachTracker][FP] no siteId yet'); return; }
        if (typeof GM_xmlhttpRequest !== 'function') { console.error('[CoachTracker][FP] GM_xmlhttpRequest unavailable — is @grant set + script reinstalled?'); return; }
        GM_xmlhttpRequest({
            method: 'GET', url: FP_API_BASE + fpSiteId, withCredentials: true, timeout: 15000,
            onload: function(r){
                if (r.status >= 200 && r.status < 300) {
                    try { fpApplyRoster(JSON.parse(r.responseText)); }
                    catch(e){ console.error('[CoachTracker][FP] roster JSON parse failed: ' + (e && e.message)); }
                } else {
                    console.warn('[CoachTracker][FP] roster HTTP ' + r.status + ' (auth? try opening Find People once)');
                }
            },
            onerror: function(err){ console.error('[CoachTracker][FP] roster fetch BLOCKED — cross-domain/@connect issue: ' + JSON.stringify(err).slice(0,120)); },
            ontimeout: function(){ console.warn('[CoachTracker][FP] roster fetch timeout'); }
        });
    }

    // ============================================================
    // === v37: QUICKSIGHT AUTO-SCRAPE (replaces manual CSV) ======
    // ============================================================
    // The Elevate "Current Week Coaching List" visual lives directly in the
    // QuickSight top-page DOM (no iframe). The table is VIRTUALIZED — only ~15
    // of ~250 rows are rendered at once — so we scroll the grid container top->
    // bottom, collecting + deduping rows, then feed the result through the SAME
    // parseElevateCSV() the CSV upload used. One leader keeping the QuickSight
    // tab open keeps everyone's Engage view current via Firebase.

    var QS_COLUMNS = 'Site ID,Pre Week Begin,Metric Name,Form URL,Associate ID,Full Name,Associate Type,Learning Curve Level,Today\u0027s Shift,Next Shift Date,Next Shift Schedule,Pre Week Total,Coaching Time,Submitted By';

    // Find the tallest scrollable grid container (the coaching table).
    function qsFindGrid() {
        // v41.7 — CONFIRMED via live console dump 2026-09-25: the coaching table's real scroll
        // container is '.fixed-grid-wrapper' (scrollHeight ~6384px, clientHeight ~328px, holding
        // the coaching-link anchors). QuickSight virtualizes: only ~24 rows are in the DOM at once
        // and are SWAPPED as this wrapper scrolls. So we MUST scroll THIS element to load the rest.
        // Pick the scrollable '.fixed-grid-wrapper' that actually contains coaching-link anchors and
        // has real overflow (scrollHeight >> clientHeight). Fall back to the tallest such wrapper.
        function hasCoachLinks(el){
            return !!el.querySelector && [].slice.call(el.querySelectorAll('a'))
                .some(function(a){ return /coaching link/i.test(a.textContent || ''); });
        }
        var wrappers = [].slice.call(document.querySelectorAll('.fixed-grid-wrapper'))
            .filter(function(el){ return el.scrollHeight > el.clientHeight + 30 && hasCoachLinks(el); });
        if (wrappers.length) {
            wrappers.sort(function(a, b){ return b.scrollHeight - a.scrollHeight; });
            return wrappers[0];
        }
        // Fallback 1: any scrollable ancestor of a coaching-link anchor.
        var link = [].slice.call(document.querySelectorAll('a'))
            .filter(function(a){ return /coaching link/i.test(a.textContent || ''); })[0];
        if (link) {
            var el = link.parentElement;
            for (var i = 0; i < 12 && el; i++) {
                if (el.scrollHeight > el.clientHeight + 30) return el;
                el = el.parentElement;
            }
        }
        // Fallback 2 (v42.2 PERF): walk UP from a coaching-link anchor to its tallest scrollable
        // ancestor — targeted and cheap. Replaces the old querySelectorAll('*') scan (every element
        // on the huge QuickSight DOM + a sub-query each), which was the last broad scan in the file.
        if (link) {
            var el2 = link.parentElement, best = null;
            for (var d = 0; d < 20 && el2; d++) {
                if (el2.scrollHeight > el2.clientHeight + 50) { if (!best || el2.scrollHeight > best.scrollHeight) best = el2; }
                el2 = el2.parentElement;
            }
            if (best) return best;
        }
        return null;
    }

    // Read the currently-rendered rows out of the coaching visual.
    // Each row = one "Coaching Link" anchor (carries login) + the sibling cell
    // divs that follow it. We key each row by login|metric to dedupe across
    // scroll steps.
    // v38: generic site-code pattern (works at ANY site — UNJ2, UFL6, UGA2, etc.):
    // 3-5 chars, starts with a letter, letters+digits. Used to identify Site ID cells.
    var SITE_CODE_RE = /^[A-Z]{3}\d$|^[A-Z]{2}\d{2}$|^[A-Z]{4}$/;
    var qsSiteTally = {}; // site code -> count, to auto-detect the dominant site

    function qsCollectVisibleRows(store) {
        // v41.6 SHAPE-AGNOSTIC — QuickSight renders the coaching visual sometimes as a real
        // <table> (<tr>/<td>) and sometimes as a flat stream of role=button cells. The old
        // collector only handled the flat stream, so when the table rendered as <tr> it found
        // 0 rows ("0 rows found"). Fix: anchor on each "Coaching Link" <a>, then read that row's
        // cells from whichever structure exists — <tr> ancestor, or the following role=button
        // siblings. Metric/name/shift are pulled positionally from the row's cells.
        function cellText(el){ return (el.textContent || '').trim(); }
        var links = [].slice.call(document.querySelectorAll('a'))
            .filter(function(a){ return /coaching link/i.test(a.textContent || '') && (a.href || '').indexOf('=') !== -1; });
        for (var li = 0; li < links.length; li++) {
            var a = links[li];
            var href = a.href || '';
            var login = decodeURIComponent(href.substring(href.lastIndexOf('=') + 1)).trim().toLowerCase();
            if (!login) continue;

            // v42.6 METRIC FROM DOM ORDER — most reliable. Column order (confirmed from live table):
            //   Site | Pre Week Begin | METRIC NAME | Form URL(=this Coaching Link anchor) | Associate ID...
            // So Metric Name is the CELL IMMEDIATELY BEFORE this anchor in DOM order. Walk backwards
            // from the anchor over the flat cell stream (role=button / td) and take the first
            // metric-ish cell. Reading the REAL DOM (not a reconstructed array) avoids the cross-row
            // misalignment that mislabeled classifications (e.g. First Pass Yield shown as Missing Items).
            var domMetric = '';
            (function(){
                function metricish(v){
                    v = (v||'').trim();
                    return !!v && /[A-Za-z]/.test(v) && !SITE_CODE_RE.test(v)
                        && !/^\d/.test(v) && !/\d{2}:\d{2}/.test(v)
                        && !/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(v)
                        && !/^coaching link$/i.test(v) && !/^(FIXED|FLEX|Veteran|LC\d)/i.test(v);
                }
                // Build an ordered list of all cell-like nodes; find the anchor's cell; step back.
                var all = [].slice.call(document.querySelectorAll('td, th, [role="gridcell"], [role="button"], a'));
                var ai = all.indexOf(a);
                if (ai === -1) {
                    // anchor not itself in the list — find the cell containing it
                    for (var z = 0; z < all.length; z++) { if (all[z].contains && all[z].contains(a)) { ai = z; break; } }
                }
                if (ai > 0) {
                    for (var b = ai - 1; b >= 0 && b >= ai - 3; b--) {
                        var tx = (all[b].textContent || '').trim();
                        if (metricish(tx)) { domMetric = tx; break; }
                    }
                }
            })();

            // Gather this row's cell texts, in order.
            var cells = [];
            var tr = a.closest ? a.closest('tr') : null;
            if (tr) {
                // Real table row: read all <td>/<th> cell texts.
                cells = [].slice.call(tr.querySelectorAll('td, th')).map(cellText);
            } else {
                // Flat stream: walk role=button siblings around the anchor to reconstruct the row.
                // Collect the run of role=button cells immediately before and after the anchor.
                var seq = [];
                // climb to a reasonable row container
                var rowEl = a.parentElement;
                for (var up = 0; up < 4 && rowEl && rowEl.querySelectorAll('[role="button"]').length < 3; up++) rowEl = rowEl.parentElement;
                if (rowEl) seq = [].slice.call(rowEl.querySelectorAll('[role="button"]')).map(cellText);
                cells = seq;
            }
            if (!cells.length) {
                // last resort: keep the login with empty metric so it still counts
                var k0 = login + '|';
                if (!store[k0]) store[k0] = { login: login, name: '', metric: '', form: href, submitted: '', shift: '', week: '' };
                continue;
            }

            // Identify columns by content (order confirmed live 2026-09-25):
            //   Site | Pre Week Begin | Metric Name | (Coaching Link) | Associate ID | Full Name |
            //   Assoc Type | LC Level | Today's Shift | Next Shift Date | ...
            var metric = '', fullName = '', todayShift = '', rowSite = '', rowWeek = '';
            // rowSite / rowWeek can still come from a scan (they're the same for the whole table).
            for (var c = 0; c < cells.length; c++) {
                var t = cells[c];
                if (!t) continue;
                if (!rowSite && SITE_CODE_RE.test(t)) { rowSite = t.toUpperCase(); }
                if (!rowWeek && /^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(t)) { rowWeek = t; }
                if (rowSite && rowWeek) break;
            }
            // v41.48 METRIC CAPTURE — ANCHORED TO THIS ROW'S LOGIN CELL (was a GLOBAL first-match scan,
            // which on the flat DOM stream grabbed a NEIGHBORING row's metric -> wrong metric + wrong
            // FORM LINK, e.g. grabenit=Combined Cycle Time showed 'Item Quality'). The confirmed column
            // order is: ... Pre Week Begin(-3) | METRIC NAME(-2) | Form URL / Coaching Link(-1) |
            // ASSOCIATE ID(login). So the metric is the cell at login_index - 2. Take it directly;
            // only if that cell is implausible do we scan the login's IMMEDIATE neighborhood (not the
            // whole stream) for a metric keyword.
            function _isMetricish(v){
                v = (v||'').trim();
                return !!v && /[A-Za-z]/.test(v) && !SITE_CODE_RE.test(v)
                    && !/^\d/.test(v) && !/\d{2}:\d{2}/.test(v)
                    && !/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/.test(v)
                    && !/^coaching link$/i.test(v) && !/^(FIXED|FLEX|Veteran|LC\d)/i.test(v);
            }
            // v42.4 METRIC CAPTURE — anchor off the ROW POSITION of THIS coaching row, robust for
            // both layouts. The metric is 1-2 cells BEFORE the "Coaching Link" cell (Metric Name is
            // immediately before Form URL). Find the anchor cell index first (always present since we
            // iterate anchors); fall back to the login-text cell. Then read the nearest metric-ish
            // cell just before it. This fixes v42.1 where requiring an exact login-text cell match
            // failed on the flat stream -> blank metric -> Elevate rows dropped (only 4 survived).
            var _anchorIdx = -1;
            for (var ci = 0; ci < cells.length; ci++) { if (/^coaching link$/i.test((cells[ci]||'').trim())) { _anchorIdx = ci; break; } }
            if (_anchorIdx === -1) { for (var ci2 = 0; ci2 < cells.length; ci2++) { if ((cells[ci2]||'').trim().toLowerCase() === login) { _anchorIdx = ci2 - 1; break; } } }
            // Metric = nearest metric-ish cell within the 3 cells before the anchor/login position.
            if (_anchorIdx >= 1) {
                for (var mp = _anchorIdx - 1; mp >= 0 && mp >= _anchorIdx - 3; mp--) {
                    var mv = (cells[mp] || '').trim();
                    if (_isMetricish(mv)) { metric = mv; break; }
                }
            }
            // Keyword fallback: scan the whole row's cells for a known metric keyword (last resort).
            if (!metric) {
                for (var kk = 0; kk < cells.length; kk++) {
                    var kv = (cells[kk] || '').trim();
                    if (/Cycle Time|Pick Skip|Pass Yield|Receive|Item Quality|Missing Items|Learning Curve|Produce|Shrink|Positive/i.test(kv)) { metric = kv; break; }
                }
            }
            // v41.31 NAME CAPTURE — must be ANCHORED TO THIS ROW'S LOGIN CELL, not a global scan.
            // The old code scanned ALL cells for the first "Last, First" match, which on the flat
            // role=button stream grabbed a NEIGHBORING row's name -> every card showed the same name
            // ("Abreu, Wilsin"). Fix: find the cell that equals THIS login, then take the adjacent
            // cell that looks like a name. Elevate layout: name is at login+1. Positive layout:
            // Full Name is also adjacent to Associate ID. Check +1 first, then -1.
            function looksLikeName(v){
                v = (v||'').trim();
                return !!v && /[A-Za-z]/.test(v) && !/^coaching/i.test(v) && !SITE_CODE_RE.test(v)
                    && !/^\d/.test(v) && !/\d{2}:\d{2}/.test(v) && !/^(FIXED|FLEX)$/i.test(v)
                    && !/^(Veteran|LC\d|Positive Reinforcement|Item Quality|Missing Items|Learning Curve|IB Receive|First Pass|False Pick|Combined Cycle|Produce)/i.test(v);
            }
            var _lni = -1;
            for (var c2 = 0; c2 < cells.length; c2++) { if ((cells[c2]||'').trim().toLowerCase() === login) { _lni = c2; break; } }
            if (_lni !== -1) {
                // prefer a "Last, First" comma name in the adjacent cells, else any name-like adjacent cell
                var _adj = [cells[_lni + 1], cells[_lni - 1]];
                for (var ai = 0; ai < _adj.length; ai++) {
                    var cand = (_adj[ai]||'').trim();
                    if (/^[A-Za-z][A-Za-z .'\-]*,\s*[A-Za-z]/.test(cand)) { fullName = cand; break; }
                }
                if (!fullName) {
                    for (var ai2 = 0; ai2 < _adj.length; ai2++) { if (looksLikeName(_adj[ai2])) { fullName = (_adj[ai2]||'').trim(); break; } }
                }
            }
            // Today's Shift: a time-range cell like "18:00:00-23:00:00" (first such wins) or '-'
            for (var c3 = 0; c3 < cells.length; c3++) { if (/\d{2}:\d{2}:\d{2}\s*-\s*\d{2}:\d{2}:\d{2}/.test(cells[c3])) { todayShift = cells[c3]; break; } }

            // v41.18: SUBMITTED-BY + COACHING-TIME capture (fixes flagging already-coached AAs).
            // Confirmed columns: "Submitted By" = a leader login (short alias, no comma, not the AA's
            // own login, not a metric/date/time/shift), "Coaching Time" = a date the coaching was done.
            // A row is DONE this week when Submitted By is filled AND Coaching Time is within the
            // current coaching week — those are hidden downstream in matchAndAlert.
            // v41.24 PRECISE COACHING-TIME + SUBMITTED-BY capture (fixes same-day completion tracking
            // without the fuzzy over-hiding that broke Elevate). Confirmed column order relative to the
            // Associate ID cell (which == login): ... Associate ID(0) | Full Name(+1) | Assoc Type(+2) |
            // LC Level(+3) | Today's Shift(+4) | Next Shift Date(+5) | Next Shift Sched(+6) |
            // Pre Week Total(+7) | COACHING TIME(+8) | SUBMITTED BY(+9). We anchor off the login cell
            // index and read those exact offsets — no guessing which date/alias is which.
            var submittedBy = '', coachingTime = '';
            var _li = -1;
            for (var ci2 = 0; ci2 < cells.length; ci2++) { if ((cells[ci2]||'').trim().toLowerCase() === login) { _li = ci2; break; } }
            if (_li !== -1) {
                var _ct = (cells[_li + 8] || '').trim();       // Coaching Time
                var _sb = (cells[_li + 9] || '').trim();       // Submitted By
                // Coaching Time must look like a date; Submitted By like a leader login (not a date/time).
                if (/^\d{4}-\d{2}-\d{2}/.test(_ct)) coachingTime = _ct.slice(0,10);
                else if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(_ct)) coachingTime = _ct;
                if (/^[a-z][a-z0-9]{2,9}$/i.test(_sb) && !/^\d/.test(_sb) && !/\d{2}:\d{2}/.test(_sb) && !/^(fixed|flex)$/i.test(_sb)) {
                    submittedBy = _sb.toLowerCase();
                }
            }

            if (domMetric) metric = domMetric;   // v42.6: DOM-order metric is authoritative
            if (rowSite) qsSiteTally[rowSite] = (qsSiteTally[rowSite] || 0) + 1;
            var key = login + '|' + metric;
            if (!store[key]) {
                store[key] = { login: login, name: fullName, metric: metric, form: href, submitted: submittedBy, coachTime: coachingTime, shift: todayShift, week: rowWeek };
            } else {
                if (todayShift && !store[key].shift) store[key].shift = todayShift;
                if (fullName && !store[key].name) store[key].name = fullName;
                if (submittedBy && !store[key].submitted) store[key].submitted = submittedBy;
                if (coachingTime && !store[key].coachTime) store[key].coachTime = coachingTime;
            }
        }
        return store;
    }

    // Build a CSV string matching parseElevateCSV's expected header, so we reuse
    // the exact same parsing + auto-complete-on-submitted logic the CSV used.
    function qsRowsToCSV(store) {
        function esc(v){ v = (v == null ? '' : String(v)); var needQ = (v.indexOf(',') !== -1) || (v.indexOf('"') !== -1) || (v.indexOf('\n') !== -1); return needQ ? '"' + v.split('"').join('""') + '"' : v; }
        var out = ['Associate ID,Full Name,Metric Name,Submitted By,Form URL,Pre Num,Today Shift,Pre Week Begin,Coaching Time'];
        Object.keys(store).forEach(function(k){
            var r = store[k];
            out.push([esc(r.login), esc(r.name), esc(r.metric), esc(r.submitted), esc(r.form), '1', esc(r.shift || ''), esc(r.week || ''), esc(r.coachTime || '')].join(','));
        });
        return out.join('\n');
    }

    var qsScrapeRunning = false;
    // Scroll the grid through its full height, collecting rows at each step.
    // v39: small status chip on QuickSight so it's OBVIOUS whether the scraper is working
    // (silent-but-broken is worse than a tiny indicator). Shows last scrape count + Firebase result.
    function ctConfirm(title, message, confirmLabel, onConfirm) {
        // v41.34: in-panel confirm — no native confirm(), so NO 'don't ask again' escape.
        var old = document.getElementById('ct-confirm-overlay'); if (old) old.remove();
        var ov = document.createElement('div'); ov.id = 'ct-confirm-overlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(15,37,64,0.45);display:flex;align-items:center;justify-content:center;';
        var box = document.createElement('div');
        box.style.cssText = 'background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.35);max-width:340px;width:90%;padding:18px 20px;font:400 13px -apple-system,Segoe UI,sans-serif;color:#1e293b;';
        var cancelBtn = onConfirm ? '<button id="ct-cf-cancel" style="background:#e2e8f0;color:#334155;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:12px;cursor:pointer;">Cancel</button>' : '';
        box.innerHTML = '<div style="font-weight:800;font-size:14px;margin-bottom:8px;color:#b91c1c;">\uD83D\uDEA8 ' + title + '</div>'
            + '<div style="font-size:12px;line-height:1.5;margin-bottom:16px;color:#334155;">' + message + '</div>'
            + '<div style="display:flex;gap:8px;justify-content:flex-end;">' + cancelBtn
            + '<button id="ct-cf-ok" style="background:#dc2626;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:800;font-size:12px;cursor:pointer;">' + (confirmLabel || 'OK') + '</button></div>';
        ov.appendChild(box); document.body.appendChild(ov);
        function closeOv(){ ov.remove(); }
        box.querySelector('#ct-cf-ok').addEventListener('click', function(){ closeOv(); if (onConfirm) onConfirm(); });
        var cb = box.querySelector('#ct-cf-cancel'); if (cb) cb.addEventListener('click', closeOv);
        ov.addEventListener('click', function(e){ if (e.target === ov) closeOv(); });
    }

    function qsStatus(msg, ok) {
        // v41.36: SILENT by default. Success/progress go to the console only (no on-screen chip
        // that lingers). ONLY real errors (ok === false) show a small dismissible chip so a broken
        // scrape is never silent. Everything else: console.log and return.
        console.log('[CoachTracker][QS] ' + msg);
        var existing = document.getElementById('ct-qs-status');
        if (ok !== false) { if (existing) existing.remove(); return; }   // success/progress -> no chip
        // error path: show a red dismissible chip
        var chip = existing;
        if (!chip) {
            chip = document.createElement('div');
            chip.id = 'ct-qs-status';
            chip.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:2147483647;background:#7f1d1d;color:#fff;font:600 11px -apple-system,Segoe UI,sans-serif;padding:7px 12px;border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,0.3);max-width:280px;cursor:pointer;';
            chip.title = 'Click to dismiss';
            chip.addEventListener('click', function(){ chip.remove(); });
            document.body.appendChild(chip);
        }
        chip.style.borderLeft = '3px solid #dc2626';
        chip.textContent = '\u26A0\uFE0F Coaching Tracker: ' + msg;
    }

    // Click any "New data present" refresh prompts so the visual renders its rows before we scrape.
    function qsDismissNewData() {
        var prompts = [].slice.call(document.querySelectorAll('[role="button"], div, span'))
            .filter(function(e){ return /new data present/i.test((e.textContent || '')) && e.children.length <= 2; });
        prompts.forEach(function(p){ try { p.click(); } catch(e) {} });
        return prompts.length;
    }

    function qsScrape(done, attempt) {
        if (qsScrapeRunning) return;
        attempt = attempt || 0;
        qsDismissNewData();                 // v39: render latest data first
        // v41.6: presence is decided by the COACHING-LINK ANCHORS, not by finding a scroll
        // container. If anchors exist, the table is showing and we can collect — even if no
        // scrollable grid is found (we then fall back to scrolling the page/window).
        function coachingAnchorCount(){
            return [].slice.call(document.querySelectorAll('a'))
                .filter(function(a){ return /coaching link/i.test(a.textContent || '') && (a.href||'').indexOf('=')!==-1; }).length;
        }
        var grid = qsFindGrid();
        if (!grid && coachingAnchorCount() === 0) {
            // Table genuinely not rendered yet — retry with backoff.
            if (attempt < 10) {
                qsStatus('waiting for coaching table\u2026 (' + (attempt + 1) + ')');
                setTimeout(function(){ qsScrape(done, attempt + 1); }, 3000);
            } else {
                qsStatus('coaching table not found \u2014 open the Associate Coaching tab', false);
                console.warn('[CoachTracker][QS] no coaching anchors after retries');
                if (done) done(0);
            }
            return;
        }
        qsScrapeRunning = true;
        qsStatus('scanning\u2026');
        var store = {};
        // v41.4 THOROUGH SCROLL — QuickSight's virtualized grid reports a SMALL scrollHeight up
        // front and GROWS it as you scroll (lazy height). Computing passes once from the initial
        // scrollHeight ends the loop early (~43 rows). Fix: re-read scrollHeight EVERY pass, step
        // by a fixed small amount, and only stop after we've reached the live bottom AND the row
        // count has been stable for several passes. This traverses the full ~138-row table.
        // v41.6: scroll whichever surface actually scrolls. If we found a grid container, drive
        // its scrollTop; otherwise fall back to scrolling the whole window. Either way we re-read
        // the scroll height each pass (QuickSight grows it lazily) and only stop at the true bottom
        // once the row count has been stable for several passes.
        // v41.8 WHEEL-EVENT SCROLL — CONFIRMED 2026-09-26: setting .scrollTop on the
        // '.fixed-grid-wrapper' does NOT advance QuickSight's virtualizer (it re-renders the same
        // ~22 rows every pass -> '22 rows synced' forever). QuickSight's grid listens for real
        // WHEEL events, not programmatic scrollTop. Fix: dispatch WheelEvent(deltaY) on the wrapper
        // each pass (and also nudge scrollTop as a belt-and-suspenders), collecting the freshly
        // swapped-in rows every step. With 'View: 1000 items' the whole ~130-row table is one page,
        // so a full wheel-scroll from top to bottom captures everything.
        var target = grid || (document.scrollingElement || document.documentElement);
        function tHeight(){ return target.scrollHeight || 0; }
        function tTop(){ return target.scrollTop || 0; }
        function tClient(){ return target.clientHeight || window.innerHeight; }
        function wheelStep(dy){
            try { target.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true })); } catch(e){}
            // belt-and-suspenders: also nudge scrollTop (harmless if ignored)
            target.scrollTop = Math.min(target.scrollTop + dy, tHeight());
        }
        var stepPx = Math.max(Math.floor(tClient() * 0.6), 120);   // ~0.6 viewport per wheel tick
        var lastCount = -1, stable = 0, guard = 0;
        target.scrollTop = 0;
        qsCollectVisibleRows(store);
        function pass() {
            wheelStep(stepPx);
            // give the virtualizer a beat, then collect
            setTimeout(function(){
                qsCollectVisibleRows(store);
                var count = Object.keys(store).length;
                var atBottom = (tTop() + tClient()) >= (tHeight() - 6);
                if (count === lastCount) stable++; else stable = 0;
                lastCount = count;
                guard++;
                // Stop only when we're at the bottom AND the row count has been stable for 5 ticks.
                // Hard guard at 400 ticks so it can never loop forever.
                if ((atBottom && stable >= 5) || guard > 400) {
                    target.scrollTop = 0;
                    try { target.dispatchEvent(new WheelEvent('wheel', { deltaY: -tHeight(), bubbles: true })); } catch(e){}
                    qsScrapeRunning = false;
                    qsPublish(store, count);
                    if (done) done(count);
                    return;
                }
                qsStatus('scanning\u2026 ' + count + ' rows');
                pass();
            }, 130);
        }
        pass();
    }

    // v41.23: SCRAPE BOTH TABS — auto-visit Associate Coaching (Elevate) AND Positive Reinforcement,
    // scrape each, then return to the original tab. Makes the tool tab-independent: Elevate and
    // Positive both stay fresh no matter which tab the user is viewing. Uses the QuickSight sheet
    // tab elements (matched by visible text).
    function qsFindTab(labelRe) {
        // QuickSight sheet tabs are clickable elements whose text is the tab name.
        var els = [].slice.call(document.querySelectorAll('[role="tab"], button, a, div'));
        for (var i = 0; i < els.length; i++) {
            var t = (els[i].textContent || '').trim();
            if (t && labelRe.test(t) && t.length < 40 && els[i].offsetParent !== null) {
                // prefer the smallest matching element (the tab label itself, not a container)
                return els[i];
            }
        }
        return null;
    }

    var qsBothRunning = false;
    function qsScrapeBothTabs(done) {
        if (qsBothRunning) { if (done) done(0); return; }
        qsBothRunning = true;
        var assocTab = qsFindTab(/^Associate Coaching$/i);
        var posTab   = qsFindTab(/^Positive Reinforcement$/i);
        // remember which tab is active now, to restore afterward
        function activeTabLabel() {
            var a = document.querySelector('[role="tab"][aria-selected="true"]');
            return a ? (a.textContent || '').trim() : '';
        }
        var original = activeTabLabel();

        function scrapeCurrent(cb) {
            // give the tab a moment to render its table, then scrape
            setTimeout(function(){ qsScrape(function(n){ cb(n); }); }, 1500);
        }

        function step1_assoc() {
            if (assocTab) { assocTab.click(); qsStatus('scanning Associate Coaching\u2026'); }
            setTimeout(function(){ scrapeCurrent(function(){ step2_pos(); }); }, 1200);
        }
        function step2_pos() {
            if (posTab) { posTab.click(); qsStatus('scanning Positive Reinforcement\u2026'); }
            setTimeout(function(){ scrapeCurrent(function(){ restore(); }); }, 1200);
        }
        function restore() {
            // return to whichever tab the user was on
            var back = original ? qsFindTab(new RegExp('^' + original.replace(/[.*+?^${}()|[\]\\]/g,'\\$&') + '$','i')) : null;
            if (back) back.click();
            qsBothRunning = false;
            matchAndAlert();
            if (done) done(1);
        }
        // If neither tab is found (not on this dashboard), just scrape whatever's showing.
        if (!assocTab && !posTab) { qsBothRunning = false; qsScrape(function(n){ matchAndAlert(); if(done)done(n); }); return; }
        step1_assoc();
    }

    // v41.45: QuickSight live-page row highlight REMOVED (unreliable on the virtualized table).
    
    // Parse scraped rows through parseElevateCSV, then push to Firebase (same
    // path the CSV upload used) so Engage tabs pull it. Silent — no QuickSight UI.
    // v38: auto-detect the site from the scraped rows (dominant Site ID). Sets ELEVATE_SITE_CODE
    // so the Firebase path is per-site — no manual prompt, works at any site. Returns the code.
    function qsAutoDetectSite() {
        var best = '', bestN = 0;
        for (var s in qsSiteTally) { if (qsSiteTally[s] > bestN) { bestN = qsSiteTally[s]; best = s; } }
        if (best && best !== ELEVATE_SITE_CODE) {
            ELEVATE_SITE_CODE = best;
            GM_setValue('elevate_site_code', best);
            console.log('[CoachTracker][QS] Site auto-detected from dashboard: ' + best);
        }
        return ELEVATE_SITE_CODE;
    }

    function qsPublish(store, count) {
        try {
            var site = qsAutoDetectSite();
            if (!site) { qsStatus('no site detected yet \u2014 will retry', false); console.warn('[CoachTracker][QS] no site code detected yet'); return; }
            // v39.3 ONE-TIME FIREBASE WIPE — clears the stale shared coaching_log (439 test/history
            // entries that flooded back after local resets). Runs once per site, now that we KNOW the
            // site code. Archives old log, then overwrites Firebase with an empty, reset-stamped log so
            // every client adopts the clean slate instead of re-merging the old entries.
            if (!GM_getValue('fb_wipe_v39_3_' + site, false)) {
                var _rid = 'reset_' + Date.now();
                GM_setValue('coachingLogResetId', _rid);
                coachingLog = [];
                GM_setValue('coachingLog', JSON.stringify(coachingLog));
                GM_setValue('elevateCompleted', '{}');
                firebaseRequest('archives/coaching_log_pre_v39_3', 'PUT', { archivedAt: Date.now(), note: 'auto-archived before v39.3 wipe' }).catch(function(){});
                firebaseRequest('coaching_log', 'PUT', { log: [], timestamp: Date.now(), resetId: _rid }).then(function(){
                    console.log('[CoachTracker][QS] v39.3 Firebase coaching_log WIPED for ' + site + ' (resetId ' + _rid + ')');
                }).catch(function(e){ console.warn('[CoachTracker][QS] wipe failed: ' + (e && e.message)); });
                GM_setValue('fb_wipe_v39_3_' + site, true);
            }
            if (count === 0) { qsStatus('0 rows found (is the coaching table showing?)', false); return; }
            var csv = qsRowsToCSV(store);
            var parsed = parseElevateCSV(csv);
            if (parsed === -1) { qsStatus('parse failed', false); console.warn('[CoachTracker][QS] parse failed'); return; }
            // v41.22: LIVE POSITIVE REBUILD — if this scrape captured Positive Reinforcement rows
            // (i.e. we're on the Positive tab), rebuild positiveByLogin FRESH from them so stale
            // Firebase entries (e.g. AAs no longer on the list) drop off. If no positive rows in
            // this scrape, keep the existing positives (don't wipe when on the Elevate tab).
            (function(){
                var freshPos = {}; var posCount = 0;
                Object.keys(store).forEach(function(k){
                    var r = store[k];
                    if (!/positive reinforcement/i.test(r.metric || '')) return;
                    var lg = (r.login||'').trim().toLowerCase(); if (!lg) return;
                    if (!freshPos[lg]) freshPos[lg] = [];
                    // dedup by login (one positive per AA)
                    if (!freshPos[lg].some(function(e){ return e.metricName === (r.metric||'Positive Reinforcement Conversation'); })) {
                        freshPos[lg].push({ metricName: r.metric || 'Positive Reinforcement Conversation',
                            fullName: r.name || '', formURL: r.form || '', shift: r.shift || '',
                            lastCoachingDate: r.coachTime || '' });
                        posCount++;
                    }
                });
                if (posCount > 0) {
                    positiveByLogin = freshPos;
                    GM_setValue('positiveData', JSON.stringify(positiveByLogin));
                    if (typeof pushPositivesToFirebase === 'function') { try { pushPositivesToFirebase(true); } catch(e){} }
                    console.log('[CoachTracker][QS] LIVE positives rebuilt: ' + Object.keys(freshPos).length + ' AAs (' + posCount + ' rows)');
                }
            })();
            qsStatus(count + ' rows \u2014 syncing to ' + site + '\u2026');
            console.log('[CoachTracker][QS] scraped ' + count + ' rows -> pushing to Firebase (' + site + ')');
            var when = new Date().toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
            pushElevateToFirebase(true).then(function(ok){
                qsStatus(ok ? ('v' + CURRENT_VERSION + ' \u00b7 ' + count + ' rows synced \u2713 ' + when) : (count + ' scraped \u2014 Firebase BLOCKED (allow connection?)'), ok);
                console.log('[CoachTracker][QS] Firebase push ' + (ok ? 'OK' : 'FAILED'));
            }).catch(function(){ qsStatus(count + ' scraped \u2014 Firebase error', false); });
            pushCoachingLogToFirebase();
        } catch (e) { qsStatus('error: ' + (e && e.message), false); console.error('[CoachTracker][QS] publish error:', e && e.message); }
    }

    // ============================================================
    // === v37: PER-COACHING LIVE CLAIMS ("in progress by X") =====
    // ============================================================
    // A claim is keyed by login|metric and records who is actively coaching it.
    // Claims live in Firebase path /claims and auto-expire so an abandoned claim
    // never locks a coaching forever. A completion clears the matching claim.
    var CLAIM_TTL_MS = 30 * 60 * 1000; // 30 minutes
    var claims = {}; // key -> { by, ts }

    function claimKey(login, metric) { return (login || '').toLowerCase() + '|' + (metric || ''); }

    function claimIsActive(c) { return c && c.by && (Date.now() - (c.ts || 0) < CLAIM_TTL_MS); }

    function getActiveClaim(login, metric) {
        var c = claims[claimKey(login, metric)];
        return claimIsActive(c) ? c : null;
    }

    async function pullClaims() {
        try {
            var payload = await firebaseRequest('claims', 'GET');
            var next = {};
            if (payload && typeof payload === 'object') {
                Object.keys(payload).forEach(function(k){
                    var c = payload[k];
                    if (claimIsActive(c)) next[k] = c; // drop expired on read
                });
            }
            claims = next;
            if (typeof updatePanel === 'function') updatePanel();
        } catch (e) { /* offline: keep local claims */ }
    }





    // ============================================================
    // === v37: ON-SITE COACHING DASHBOARD (top of Engage panel) ==
    // ============================================================
    // Aggregates currentMatches (on-site associates WITH pending coachings) into
    // a summary strip. Recomputes on every matchAndAlert()/updatePanel() pass.
    // Tiles: on-site assoc needing coaching, total pending, by metric type,
    // by coaching category, completed-today vs remaining.

    var CATEGORY_LABEL = { ELEV:'Elevate', POS:'Positive' };

    function isSameLocalDay(ts, now) {
        var a = new Date(ts), b = new Date(now);
        return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
    }

    // Count coachings this leader (or anyone) completed TODAY from the coaching log.
    function completedTodayCount() {
        // v41.41: NET tool completions today (latest action wins) + same-day DASHBOARD completions
        // (Submitted By + Coaching Time == today). Matches the "Done Today (by leader)" list exactly.
        // Metric keys are DATE-STRIPPED so old malformed 'metric|YYYY-MM-DD' entries still net vs undo.
        var now = Date.now();
        function baseKey(login, metric){
            var m = (metric||'').replace(/\|\d{4}-\d{2}-\d{2}.*$/, '');   // drop any leaked date
            return (login||'').toLowerCase() + '|' + m;
        }
        var state = {};   // key -> {action, ts}
        for (var i=0;i<coachingLog.length;i++){
            var e = coachingLog[i];
            if (!e || !e.timestamp || !isSameLocalDay(e.timestamp, now)) continue;
            var k = baseKey(e.login, e.metric);
            if (!state[k] || e.timestamp >= state[k].ts) state[k] = { action: e.action || 'completed', ts: e.timestamp };
        }
        var done = {};
        for (var kk in state) { if (state[kk].action === 'completed') done[kk] = true; }
        // Add same-day dashboard completions (not done via the tool). Dedup against tool completions.
        try {
            Object.keys(elevateByLogin || {}).forEach(function(login){
                (elevateByLogin[login] || []).forEach(function(a){
                    if (a.submittedBy && a.coachTime && a.coachTime === todayKey()) {
                        done[baseKey(login, a.metric)] = true;
                    }
                });
            });
        } catch(e) {}
        return Object.keys(done).length;
    }

    // v37: active dashboard filter (null = show all). Shape: {kind:'all'|'pending'|'inprogress'|'done'|'positive'|'category'|'metric', value?}
    var activeDashFilter = null;

    // v39: collapsible dropdown section builders (rendered collapsed; toggled by delegated listener).

    // Coaching Log — full completion history (most recent first).
    function buildLogHTML() {
        // v41.40: Coaching Log = TOOL actions only (reverted the dashboard merge — dashboard
        // completions belong in "Done Today (by leader)", not this raw tool audit trail).
        if (!coachingLog || coachingLog.length === 0) return '<div class="ct-drop-empty">No coaching actions logged today yet.</div>';
        var rows = '';
        // v42.8: TODAY-ONLY log — entries from prior days (e.g. yesterday's DONE/UNDO) must NOT show
        // in today's log. Daily-reset model: the log is a same-day audit trail. Filter to today.
        var _now = Date.now();
        var sorted = coachingLog.slice()
            .filter(function(e){ return e && e.timestamp && isSameLocalDay(e.timestamp, _now); })
            .sort(function(a,b){ return (b.timestamp||0) - (a.timestamp||0); });
        if (sorted.length === 0) return '<div class="ct-drop-empty">No coaching actions logged today yet.</div>';
        for (var i = 0; i < sorted.length && i < 200; i++) {
            var e = sorted[i];
            var t = e.timestamp ? new Date(e.timestamp) : null;
            var when = t ? ((t.getMonth()+1)+'/'+t.getDate()+' '+t.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})) : (e.source === 'dashboard' ? 'QuickSight (today)' : '-');
            var isUndo = e.action !== 'completed';
            // v41.38: clearly LABEL undos (not just a bare arrow) + strip any leaked |date from metric.
            var mtr = (e.metric||'-').replace(/\|\d{4}-\d{2}-\d{2}.*$/, '');
            var actHtml = isUndo
                ? '<span style="color:#b91c1c;font-weight:700;font-size:9px;">\u21A9 UNDO</span>'
                : '<span style="color:#166534;font-weight:700;font-size:9px;">\u2705 DONE</span>';
            var rowStyle = isUndo ? ' style="background:#fef2f2;"' : '';
            rows += '<tr' + rowStyle + '><td>' + (e.login||'-') + '</td><td>' + mtr + '</td><td>' + (e.completedBy||'?') + '</td><td>' + when + '</td><td>' + actHtml + '</td></tr>';
        }
        return '<div style="font-size:9px;color:#64748b;padding:2px 4px 6px;">Today\'s log — all leaders, newest first. \u2705 DONE / \u21A9 UNDO.</div>'
             + '<table class="ct-drop-table"><thead><tr><th>Assoc</th><th>Metric</th><th>By</th><th>When</th><th>Action</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    // Team Summary — reuse the same per-leader tally logic as the modal.
    // v39.3: only count REAL leader completions done in the tool. Excludes auto placeholders
    // ('elevate-auto','auto-submitted') and dashboard-submitted noise, so the tally is trustworthy
    // (fixes e.g. bnatherr — on vacation — appearing as having 'completed' 14, or a zone like 'chilled').
    function isRealLeader(by) {
        if (!by) return false;
        var b = by.toLowerCase();
        if (b === 'elevate-auto' || b === 'auto-submitted' || b === 'unknown') return false;
        return true;
    }
    function buildSummaryHTML() {
        var pairs = {}, totals = {};
        for (var i = 0; i < coachingLog.length; i++) {
            var e = coachingLog[i]; if (!e || !e.login) continue;
            var pk = ckey(e.login, e.metric);
            if (e.action === 'completed' && isRealLeader(e.completedBy)) { if (!pairs[pk]) pairs[pk] = e.completedBy; }
            else if (e.action === 'unmarked') { delete pairs[pk]; }
        }
        for (var k in pairs) { totals[pairs[k]] = (totals[pairs[k]]||0)+1; }
        var leaders = Object.keys(totals).sort(function(a,b){return totals[b]-totals[a];});
        if (leaders.length === 0) return '<div class="ct-drop-empty">No leader completions yet this week.</div>';
        var rows = leaders.map(function(l){ return '<tr><td><b>'+l+'</b></td><td>'+totals[l]+'</td></tr>'; }).join('');
        return '<table class="ct-drop-table"><thead><tr><th>Leader</th><th>Completed</th></tr></thead><tbody>' + rows + '</tbody></table>';
    }

    // Hide Types — toggle Elevate / Positive visibility (uses hiddenTypes + the existing mm-hide-toggle wiring).
    function buildHideTypesHTML() {
        var elevHidden = hiddenTypes.indexOf('ELEV') >= 0;
        var posHidden = hiddenTypes.indexOf('POS') >= 0;
        return '<div class="ct-hide-row">'
            + '<span class="ct-hide-toggle" data-hidetype="ELEV" style="background:' + (elevHidden ? '#cbd5e1' : '#E74C3C') + ';">' + (elevHidden ? '\uD83D\uDEAB' : '\u2705') + ' Elevate</span>'
            + '<span class="ct-hide-toggle" data-hidetype="POS" style="background:' + (posHidden ? '#cbd5e1' : '#10B981') + ';">' + (posHidden ? '\uD83D\uDEAB' : '\u2705') + ' Positive</span>'
            + '</div>';
    }

    // Completed — recently completed items with an undo (un-mark) action.
    function buildCompletedHTML() {
        // v41.27: MERGE TWO SOURCES for today's completions so the per-leader summary is accurate
        // even when a coaching was completed on the QuickSight dashboard WITHOUT the tool:
        //   (1) Tool ✓ completions (elevateCompleted, timestamped today) — undoable.
        //   (2) Dashboard completions: any scraped coaching with Submitted By filled AND
        //       Coaching Time == today — credited to that leader (read-only, no undo).
        // Deduped by login|metric; unified per-leader tally.
        var todayStart = new Date(); todayStart.setHours(0,0,0,0); var todayMs = todayStart.getTime();
        var completed = JSON.parse(GM_getValue('elevateCompleted', '{}'));
        var rows = [];            // {login, metric, by, ts, source}
        var seen = {};

        // (1) tool completions today
        Object.keys(completed).forEach(function(k){
            if ((completed[k].timestamp||0) < todayMs) return;
            // v41.35 KEY FORMAT FIX: completion keys are login|metric|DATE (ckey appends todayKey()).
            // The old split folded the DATE into the metric ("...Conversation|2026-09-26"), so the
            // dedup key never matched the dashboard row -> DUPLICATE, and undo (which re-keys the
            // metric) never cancelled it. Strip the trailing YYYY-MM-DD date segment off the metric.
            var parts = k.split('|'); var login = parts[0];
            var rest = parts.slice(1);
            if (rest.length && /^\d{4}-\d{2}-\d{2}$/.test(rest[rest.length - 1])) rest.pop();  // drop date
            var metric = rest.join('|');
            var pk = login + '|' + metric;
            if (seen[pk]) return;              // guard against any residual dupes
            seen[pk] = true;
            rows.push({ login: login, metric: metric, by: completed[k].completedBy || 'unknown',
                        ts: completed[k].timestamp || 0, source: 'tool' });
        });

        // (2) dashboard completions today (from scraped Elevate alerts)
        Object.keys(elevateByLogin || {}).forEach(function(login){
            (elevateByLogin[login] || []).forEach(function(a){
                if (a.submittedBy && a.coachTime && a.coachTime === todayKey()) {
                    var pk = login + '|' + (a.metric || '');
                    if (seen[pk]) return;          // already counted as a tool completion
                    seen[pk] = true;
                    rows.push({ login: login, metric: a.metric || '', by: a.submittedBy, ts: 0, source: 'dashboard' });
                }
            });
        });

        if (rows.length === 0) return '<div class="ct-drop-empty">No coachings completed today yet.</div>';
        rows.sort(function(a,b){ return (b.ts||0) - (a.ts||0); });

        // Per-leader tally (both sources)
        var tally = {};
        rows.forEach(function(r){ var by = r.by || 'unknown'; tally[by] = (tally[by]||0)+1; });
        var tallyRow = Object.keys(tally).sort(function(a,b){ return tally[b]-tally[a]; })
            .map(function(l){ return '<span style="display:inline-block;background:#dcfce7;color:#166534;border:1px solid #86efac;border-radius:10px;padding:1px 8px;margin:2px 3px;font-size:10px;font-weight:700;">' + l + ' \u00b7 ' + tally[l] + '</span>'; }).join('');
        var header = '<div style="padding:6px 4px 8px;font-size:10px;color:#475569;"><b>' + rows.length + '</b> completed today by leader:<div style="margin-top:4px;">' + tallyRow + '</div></div>';

        var body = '';
        for (var i = 0; i < rows.length && i < 300; i++) {
            var r = rows[i];
            var tstr = r.ts ? new Date(r.ts).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}) : (r.source === 'dashboard' ? 'dashboard' : '');
            var undo = (r.source === 'tool')
                ? '<button class="ct-undo-btn" data-login="' + r.login + '" data-metric="' + (r.metric||'').replace(/"/g,'&quot;') + '" data-by="' + (r.by||'') + '">\u21A9 undo</button>'
                : '<span style="font-size:9px;color:#94a3b8;">QuickSight</span>';
            body += '<tr><td>' + r.login + '</td><td>' + (r.metric||'') + '</td><td>' + r.by + '</td><td style="color:#94a3b8;">' + tstr + '</td><td>' + undo + '</td></tr>';
        }
        return header + '<table class="ct-drop-table"><thead><tr><th>Assoc</th><th>Metric</th><th>By</th><th>Time</th><th></th></tr></thead><tbody>' + body + '</tbody></table>';
    }

    function buildDashboardHTML() {
        // v39: TRUE on-site headcount from Find People (live roster), separate from "needs coaching".
        var assocCount = onSiteCount;               // On-site tile = clocked in now (Find People)
        var needsCoaching = currentMatches.length;  // on-site associates with >=1 pending coaching
        var totalPending = 0, claimedCount = 0, positiveCount = 0;
        var byMetric = {}, byCategory = {};
        for (var i=0;i<currentMatches.length;i++){
            var alerts = currentMatches[i].alerts || [];
            for (var a=0;a<alerts.length;a++){
                totalPending++;
                var t = alerts[a].type || 'ELEV';
                byCategory[t] = (byCategory[t]||0)+1;
                if (t === 'POS') positiveCount++;
                var mk = (alerts[a].metric||'').trim() || CATEGORY_LABEL[t] || t;
                byMetric[mk] = (byMetric[mk]||0)+1;
                if (getActiveClaim(currentMatches[i].login, alerts[a].metric)) claimedCount++;
            }
        }
        var doneToday = completedTodayCount();
        var totalTracked = doneToday + totalPending;
        var pct = totalTracked > 0 ? Math.round((doneToday/totalTracked)*100) : 0;

        function isActive(kind, value){ return activeDashFilter && activeDashFilter.kind===kind && (value===undefined || activeDashFilter.value===value); }
        // Clickable tile: carries data-filter (+ optional data-value) read by the delegated listener.
        function tile(kind, label, val, bg, sub){
            var act = isActive(kind) ? ' ct-tile-active' : '';
            var subHtml = sub ? '<div class="ct-tile-sub">'+sub+'</div>' : '';
            return '<button class="ct-tile'+act+'" data-filter="'+kind+'" style="background:'+bg+';"><div class="ct-tile-n">'+val+'</div><div class="ct-tile-l">'+label+'</div>'+subHtml+'</button>';
        }

        var html = '<div id="ct-dashboard">';
        // Row 1: 3 tiles
        html += '<div class="ct-tiles">';
        html += tile('all', 'On-Site', assocCount, '#1e3a5f', '(Clocked In)');       // true on-site headcount
        html += tile('pending', 'AAs to Coach', needsCoaching, '#7c2d2d', totalPending + ' coachings');  // big=on-site AAs (people), sub=total coaching items
        html += tile('inprogress', 'In Progress', claimedCount, '#5b3a7c');
        html += '</div>';
        // Row 2: 2 tiles (Positive + Done today)
        html += '<div class="ct-tiles">';
        html += tile('positive', '\u2b50 Positive', positiveCount, '#8a5a00', '(On-Site)');
        html += tile('done', 'Done', doneToday, '#1f5c3a', '(Today)');
        html += '</div>';
        // Progress bar
        html += '<div class="ct-prog-wrap"><div class="ct-prog-label">Coached today vs. remaining &mdash; '+doneToday+' / '+totalTracked+' ('+pct+'%)</div>'
             +  '<div class="ct-prog-track"><div class="ct-prog-fill" style="width:'+pct+'%;"></div></div></div>';
        // Metric pills (clickable filters)
        var metKeys = Object.keys(byMetric).sort(function(a,b){return byMetric[b]-byMetric[a];});
        if (metKeys.length){
            html += '<div class="ct-break"><div class="ct-break-h">Filter by metric</div><div class="ct-break-row">';
            metKeys.forEach(function(k){
                var act = isActive('metric', k) ? ' ct-pill-active' : '';
                html += '<button class="ct-pill ct-pill-metric'+act+'" data-filter="metric" data-value="'+k.replace(/"/g,'&quot;')+'">'+k+' <b>'+byMetric[k]+'</b></button>';
            });
            html += '</div></div>';
        }
        // Active-filter chip + clear
        if (activeDashFilter && activeDashFilter.kind !== 'all'){
            var lbl = activeDashFilter.kind==='metric' ? activeDashFilter.value
                    : activeDashFilter.kind==='pending' ? 'Pending'
                    : activeDashFilter.kind==='inprogress' ? 'In progress'
                    : activeDashFilter.kind==='positive' ? 'Positive'
                    : activeDashFilter.kind==='done' ? 'Done today' : activeDashFilter.kind;
            html += '<div class="ct-activefilter">Showing: <b>'+lbl+'</b> <button class="ct-clearfilter" data-filter="all">\u2715 clear</button></div>';
        }
        // v41.28: DEBUG readout removed — data verified accurate. (was: pending/onSite/flagged diagnostics)
        html += '</div>';
        return html;
    }

    // v37: render the "in progress by X" indicator for a coaching row (or '' if unclaimed).
    function claimIndicatorHTML(login, metric) {
        var c = getActiveClaim(login, metric);
        if (!c) return '';
        var leader = (GM_getValue('leader_login','') || '').toLowerCase();
        var mins = Math.max(0, Math.round((Date.now() - (c.ts||0))/60000));
        var mine = (c.by || '').toLowerCase() === leader;
        var label = mine ? '\uD83D\uDD12 You (' + mins + 'm)' : '\uD83D\uDD12 ' + c.by + ' (' + mins + 'm)';
        return '<span class="ct-claim' + (mine ? ' ct-claim-mine' : '') + '" title="Someone is coaching this right now (auto-expires 30m)">' + label + '</span>';
    }

    // === INIT (v40: QuickSight is the single home; Find People only donates its site ID) ===
    var IS_QUICKSIGHT = /quicksight\.aws\.amazon\.com$/.test(location.hostname);
    var IS_FINDPEOPLE = /store-management\.[a-z0-9.]*amazon\.dev$/.test(location.hostname);

    if (IS_FINDPEOPLE) {
        // -------- Find People tab: SITE-ID DONOR only (no panel) --------
        // We just need to capture this site's Find People UUID once and save it, so the QuickSight
        // tab can call the Find People API cross-domain for the LIVE on-site roster. Lightweight.
        console.log('%c[CoachTracker] v41 FIND PEOPLE — capturing site ID for QuickSight', 'background:#0f2d4a;color:#fff;padding:2px 6px;border-radius:3px;');
        fpInterceptSiteId();
        (function(){
            var tries = 0;
            var poll = setInterval(function(){
                tries++;
                fpRecoverSiteIdFromPerf();
                if (fpSiteId) { console.log('[CoachTracker][FP] site ID saved for QuickSight: ' + fpSiteId); clearInterval(poll); }
                else if (tries > 40) { clearInterval(poll); }
            }, 3000);
        })();
        return; // no panel on Find People in v40
    }

    if (IS_QUICKSIGHT) {
        // -------- QuickSight tab: FULL PANEL — coachings (local scrape) + live on-site (Find People API) --------
        console.log('%c[CoachTracker] v' + CURRENT_VERSION + ' QUICKSIGHT — coaching scrape + live Find People on-site', 'background:#0f2d4a;color:#fff;padding:2px 6px;border-radius:3px;');
        createButton();
        // v42.9: self-heal — if QuickSight's SPA ever removes our button from the DOM,
        // recreate it. Cheap check every 10s.
        setInterval(function(){ if (!document.getElementById('mm-btn')) { try { createButton(); updateButton(); var _p = document.getElementById('mm-panel'); var _b = document.getElementById('mm-btn'); if (_b && _p && _p.classList.contains('visible')) _b.style.display = 'none'; } catch(e){} } }, 10000);
        loadElevateCache();
        loadCoachingLogCache();
        // Scrape coachings from THIS page (native), push to Firebase, and refresh the panel.
        // v41.25: IDLE-GATED tab switching. Do ONE both-tabs run at startup so Elevate + Positive
        // are both fresh. After that, only auto-switch tabs when the user is IDLE (no mouse/key/scroll
        // for 60s) — otherwise just scrape whatever tab is currently showing (no disruptive switching).
        var qsLastActivity = Date.now();
        ['mousemove','mousedown','keydown','wheel','scroll','touchstart'].forEach(function(ev){
            document.addEventListener(ev, function(){ qsLastActivity = Date.now(); }, true);
        });
        var QS_IDLE_MS = 60 * 1000;   // consider idle after 60s of no activity
        var qsDidFirstRun = false;
        var qsKick = function(){
            var runBoth = !qsDidFirstRun || (Date.now() - qsLastActivity >= QS_IDLE_MS);
            qsDidFirstRun = true;
            pullCoachingLogFromFirebase().then(function(){
                if (runBoth) qsScrapeBothTabs(function(){ matchAndAlert(); });
                else qsScrape(function(){ matchAndAlert(); });   // active: current tab only, no switching
            }).catch(function(){
                if (runBoth) qsScrapeBothTabs(function(){ matchAndAlert(); });
                else qsScrape(function(){ matchAndAlert(); });
            });
        };
        setTimeout(qsKick, 6000);           // first run = both tabs
        setInterval(qsKick, 10 * 60 * 1000); // subsequent runs = both only when idle
        // LIVE on-site from Find People API (cross-domain via GM_xmlhttpRequest). Needs the site ID
        // captured once from Find People. Poll for it, then fetch the roster and keep it fresh (90s).
        (function(){
            var tries = 0;
            var poll = setInterval(function(){
                tries++;
                if (!fpSiteId) { try { fpSiteId = GM_getValue('fp_site_id', '') || (FP_KNOWN_SITE_IDS[ELEVATE_SITE_CODE || GM_getValue('elevate_site_code','')] || ''); } catch(e) {} }
                if (fpSiteId) { fpFetchRoster(); if (onSiteCount > 0) { clearInterval(poll); } }
                if (tries > 40) clearInterval(poll);
            }, 3000);
        })();
        setInterval(function(){ if (!fpSiteId) { try { fpSiteId = GM_getValue('fp_site_id',''); } catch(e){} } if (fpSiteId) fpFetchRoster(); }, 3 * 60 * 1000);   // v42.3: 3-min roster (was 90s)
        setInterval(function(){ pullElevateFromFirebase(); }, ELEVATE_SYNC_MS);
        setInterval(function(){ pullCoachingLogFromFirebase(); }, 5 * 60 * 1000);   // v42.3: 5-min (was 2)
        setInterval(function(){ pullClaims(); }, 2 * 60 * 1000);   // v42.3: 2-min (was 45s)
        setTimeout(function(){ pullClaims(); }, 3000);
        return;
    }

    console.log('[CoachTracker] v41 loaded on an unmatched host — idle.');
})();
