"""
Minimal iCalendar (.ics) reader for availability (busy/free) views.

Standard library only. Handles what Google Calendar's "secret address in iCal
format" produces: time zones (TZID), all-day events, recurring events (RRULE
with DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY),
EXDATE exclusions, moved/cancelled single occurrences (RECURRENCE-ID),
cancelled events and events marked "free" (TRANSP:TRANSPARENT).

Only start/end times are returned, never titles, so teammates see busy blocks only.
"""
import re
import threading
import time
import urllib.request
from datetime import date, datetime, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

MAX_BYTES = 8 * 1024 * 1024
FETCH_TIMEOUT = 20
CACHE_SECONDS = 300
WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}

_cache = {}
_cache_lock = threading.Lock()


class FeedError(Exception):
    pass


# ---------------------------------------------------------------- fetching
def normalize_url(url):
    url = (url or "").strip()
    if url.startswith("webcal://"):
        url = "https://" + url[len("webcal://"):]
    if not re.match(r"^https?://", url):
        raise FeedError("That doesn't look like a calendar link. It should start with https://")
    return url


def fetch(url, use_cache=True):
    url = normalize_url(url)
    now = time.time()
    if use_cache:
        with _cache_lock:
            hit = _cache.get(url)
            if hit and now - hit[0] < CACHE_SECONDS:
                return hit[1]
    req = urllib.request.Request(url, headers={"User-Agent": "Tenfold/1.0 (calendar availability)"})
    try:
        with urllib.request.urlopen(req, timeout=FETCH_TIMEOUT) as resp:
            data = resp.read(MAX_BYTES + 1)
    except Exception as e:
        raise FeedError(f"Couldn't download the calendar ({e.__class__.__name__}). Check the link is the secret iCal address.")
    if len(data) > MAX_BYTES:
        raise FeedError("Calendar is too large to read.")
    text = data.decode("utf-8", errors="replace")
    if "BEGIN:VCALENDAR" not in text:
        raise FeedError("That link didn't return a calendar. Use the 'Secret address in iCal format'.")
    with _cache_lock:
        _cache[url] = (now, text)
    return text


def forget(url):
    try:
        url = normalize_url(url)
    except FeedError:
        return
    with _cache_lock:
        _cache.pop(url, None)


# ---------------------------------------------------------------- parsing
def _unfold(text):
    out = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if line[:1] in (" ", "\t") and out:
            out[-1] += line[1:]
        else:
            out.append(line)
    return out


def _parse_line(line):
    # NAME;PARAM=VAL;PARAM="V:AL":VALUE  (colon inside quotes is not the separator)
    in_q = False
    for i, ch in enumerate(line):
        if ch == '"':
            in_q = not in_q
        elif ch == ":" and not in_q:
            head, value = line[:i], line[i + 1:]
            break
    else:
        return None
    parts = head.split(";")
    name = parts[0].upper()
    params = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v.strip('"')
    return name, params, value


def _tz(name, default):
    if name and ZoneInfo:
        try:
            return ZoneInfo(name)
        except Exception:
            pass
    return default


def _parse_dt(value, params, cal_tz):
    """Returns (datetime or date, is_all_day). Datetimes are timezone-aware."""
    value = value.strip()
    if params.get("VALUE") == "DATE" or re.fullmatch(r"\d{8}", value):
        return date(int(value[0:4]), int(value[4:6]), int(value[6:8])), True
    m = re.fullmatch(r"(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?", value)
    if not m:
        raise ValueError("bad date " + value)
    y, mo, d, hh, mm, ss, z = m.groups()
    naive = datetime(int(y), int(mo), int(d), int(hh), int(mm), int(ss or 0))
    if z:
        return naive.replace(tzinfo=timezone.utc), False
    return naive.replace(tzinfo=_tz(params.get("TZID"), cal_tz)), False


def _parse_duration(value):
    m = re.fullmatch(r"([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", value.strip())
    if not m:
        return None
    sign, w, d, h, mi, s = m.groups()
    td = timedelta(weeks=int(w or 0), days=int(d or 0), hours=int(h or 0), minutes=int(mi or 0), seconds=int(s or 0))
    return -td if sign == "-" else td


def parse_events(text):
    lines = _unfold(text)
    cal_tz = timezone.utc
    for line in lines:
        if line.upper().startswith("X-WR-TIMEZONE"):
            p = _parse_line(line)
            if p:
                cal_tz = _tz(p[2].strip(), timezone.utc)
            break

    events, cur, depth = [], None, 0
    for line in lines:
        upper = line.upper()
        if upper == "BEGIN:VEVENT":
            cur, depth = {"exdates": []}, 0
            continue
        if cur is None:
            continue
        if upper.startswith("BEGIN:"):
            depth += 1  # e.g. VALARM inside the event
            continue
        if upper.startswith("END:") and upper != "END:VEVENT":
            depth -= 1
            continue
        if upper == "END:VEVENT":
            events.append(cur)
            cur = None
            continue
        if depth > 0:
            continue
        p = _parse_line(line)
        if not p:
            continue
        name, params, value = p
        try:
            if name in ("DTSTART", "DTEND", "RECURRENCE-ID"):
                cur[name], allday = _parse_dt(value, params, cal_tz)
                if name == "DTSTART":
                    cur["allday"] = allday
            elif name == "DURATION":
                cur["DURATION"] = _parse_duration(value)
            elif name == "RRULE":
                cur["RRULE"] = dict(kv.split("=", 1) for kv in value.upper().split(";") if "=" in kv)
            elif name == "EXDATE":
                for v in value.split(","):
                    cur["exdates"].append(_parse_dt(v, params, cal_tz)[0])
            elif name in ("UID", "STATUS", "TRANSP"):
                cur[name] = value.strip()
        except (ValueError, KeyError):
            continue
    return [e for e in events if "DTSTART" in e]


# ---------------------------------------------------------------- recurrence
def _key(v):
    """Comparable key for matching occurrences (EXDATE / RECURRENCE-ID)."""
    if isinstance(v, datetime):
        return v.astimezone(timezone.utc).replace(second=0, microsecond=0)
    return v


def _nth_weekday(year, month, weekday, n):
    if n > 0:
        first = date(year, month, 1)
        d = first + timedelta(days=(weekday - first.weekday()) % 7 + 7 * (n - 1))
    else:
        nxt = date(year + (month == 12), month % 12 + 1, 1)
        last = nxt - timedelta(days=1)
        d = last - timedelta(days=(last.weekday() - weekday) % 7 + 7 * (-n - 1))
    return d if d.month == month else None


def _with_date(start, d):
    if isinstance(start, datetime):
        return start.replace(year=d.year, month=d.month, day=d.day)
    return d


def _occurrences(ev, win_end):
    """Yield occurrence starts (same type as DTSTART) up to win_end."""
    start = ev["DTSTART"]
    rule = ev.get("RRULE")
    if not rule:
        yield start
        return
    freq = rule.get("FREQ", "")
    interval = max(1, int(rule.get("INTERVAL", "1") or 1))
    count = int(rule["COUNT"]) if rule.get("COUNT", "").isdigit() else None
    until = None
    if rule.get("UNTIL"):
        try:
            until, _ = _parse_dt(rule["UNTIL"], {}, timezone.utc)
        except ValueError:
            until = None
    byday = [b for b in rule.get("BYDAY", "").split(",") if b]
    bymonthday = [int(x) for x in rule.get("BYMONTHDAY", "").split(",") if x.lstrip("-").isdigit()]

    def past_until(o):
        if until is None:
            return False
        if isinstance(o, datetime) and isinstance(until, datetime):
            return o.astimezone(timezone.utc) > until
        od = o.date() if isinstance(o, datetime) else o
        ud = until.date() if isinstance(until, datetime) else until
        return od > ud

    def beyond(o):
        if isinstance(o, datetime):
            return o.astimezone(timezone.utc) > win_end
        return datetime(o.year, o.month, o.day, tzinfo=timezone.utc) > win_end

    emitted, guard = 0, 0
    start_d = start.date() if isinstance(start, datetime) else start

    def candidates():
        if freq == "DAILY":
            i = 0
            while True:
                yield [start_d + timedelta(days=i * interval)]
                i += 1
        elif freq == "WEEKLY":
            days = sorted(WEEKDAYS[b[-2:]] for b in byday if b[-2:] in WEEKDAYS) or [start_d.weekday()]
            week0 = start_d - timedelta(days=start_d.weekday())
            i = 0
            while True:
                wk = week0 + timedelta(weeks=i * interval)
                yield [wk + timedelta(days=wd) for wd in days]
                i += 1
        elif freq == "MONTHLY":
            i = 0
            while True:
                m0 = start_d.month - 1 + i * interval
                y, m = start_d.year + m0 // 12, m0 % 12 + 1
                out = []
                if byday:
                    for b in byday:
                        mt = re.fullmatch(r"([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)", b)
                        if mt and mt.group(1):
                            d = _nth_weekday(y, m, WEEKDAYS[mt.group(2)], int(mt.group(1)))
                            if d:
                                out.append(d)
                else:
                    for md in (bymonthday or [start_d.day]):
                        try:
                            if md < 0:
                                nxt = date(y + (m == 12), m % 12 + 1, 1)
                                out.append(nxt + timedelta(days=md))
                            else:
                                out.append(date(y, m, md))
                        except ValueError:
                            pass  # e.g. Feb 30 is skipped, like Google does
                yield sorted(out)
                i += 1
        elif freq == "YEARLY":
            i = 0
            while True:
                try:
                    yield [start_d.replace(year=start_d.year + i * interval)]
                except ValueError:
                    yield []
                i += 1
        else:
            yield [start_d]

    for batch in candidates():
        guard += 1
        if guard > 6000:
            return
        for d in batch:
            if d < start_d:
                continue
            occ = _with_date(start, d)
            if past_until(occ) or (count is not None and emitted >= count):
                return
            if beyond(occ):
                return
            emitted += 1
            yield occ
        if freq not in ("DAILY", "WEEKLY", "MONTHLY", "YEARLY"):
            return


def busy_blocks(text, win_start, win_end):
    """
    Return {"busy": [(start_utc, end_utc)], "allday": [date, ...]} for events
    overlapping [win_start, win_end] (both aware UTC datetimes).
    """
    events = parse_events(text)
    overrides = {}
    for ev in events:
        if "RECURRENCE-ID" in ev:
            overrides.setdefault(ev.get("UID"), set()).add(_key(ev["RECURRENCE-ID"]))

    busy, allday = [], set()
    for ev in events:
        if ev.get("STATUS", "").upper() == "CANCELLED" or ev.get("TRANSP", "").upper() == "TRANSPARENT":
            continue
        start = ev["DTSTART"]
        if "DTEND" in ev:
            length = ev["DTEND"] - start
        elif ev.get("DURATION") is not None:
            length = ev["DURATION"]
        else:
            length = timedelta(days=1) if ev.get("allday") else timedelta(0)
        if length.total_seconds() < 0:
            length = timedelta(0)
        skip = {_key(x) for x in ev["exdates"]}
        if "RRULE" in ev and "RECURRENCE-ID" not in ev:
            skip |= overrides.get(ev.get("UID"), set())
        occs = _occurrences(ev, win_end) if "RECURRENCE-ID" not in ev else [start]
        for occ in occs:
            if _key(occ) in skip:
                continue
            if ev.get("allday"):
                d0 = occ if not isinstance(occ, datetime) else occ.date()
                ndays = max(1, length.days)
                for k in range(ndays):
                    d = d0 + timedelta(days=k)
                    if win_start.date() - timedelta(days=1) <= d <= win_end.date() + timedelta(days=1):
                        allday.add(d)
                continue
            s = occ.astimezone(timezone.utc)
            e = (occ + length).astimezone(timezone.utc)
            if e > win_start and s < win_end and e > s:
                busy.append((max(s, win_start), min(e, win_end)))
    busy.sort()
    merged = []
    for s, e in busy:  # merge overlaps so nothing about event boundaries leaks beyond "busy"
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return {"busy": merged, "allday": sorted(allday)}
