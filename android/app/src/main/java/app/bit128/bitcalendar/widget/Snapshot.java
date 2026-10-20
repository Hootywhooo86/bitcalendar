package app.bit128.bitcalendar.widget;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONObject;

/** What the app last told the widgets: events around today, open tasks, and a couple of settings. */
public final class Snapshot {
    static final String PREFS = "bitcal_widget";

    public static final class Event {
        public String title; public long start, end; public boolean allDay; public int color; public String day;
        public String location = "", notes = "";
    }

    public final List<Event> events = new ArrayList<>();
    public final Set<String> taskDays = new HashSet<>();
    public final List<String[]> tasks = new ArrayList<>(); // {title, YYYY-MM-DD}
    public int weekStart = 0;
    public boolean h24 = false;
    public boolean empty = true;

    static SharedPreferences prefs(Context c) { return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    public static void save(Context c, String json) { prefs(c).edit().putString("snapshot", json).apply(); }

    public static Snapshot load(Context c) {
        Snapshot s = new Snapshot();
        String raw = prefs(c).getString("snapshot", null);
        if (raw == null) return s;
        try {
            JSONObject o = new JSONObject(raw);
            s.weekStart = o.optInt("weekStart", 0);
            s.h24 = o.optBoolean("h24", false);
            JSONArray ev = o.optJSONArray("events");
            for (int i = 0; ev != null && i < ev.length(); i++) {
                JSONObject j = ev.getJSONObject(i);
                Event e = new Event();
                e.title = j.optString("t", "");
                e.start = j.optLong("s");
                e.end = j.optLong("e");
                e.allDay = j.optInt("a", 0) == 1;
                e.day = j.optString("d", "");
                e.location = j.optString("l", "");
                e.notes = j.optString("n", "");
                try { e.color = Color.parseColor(j.optString("c", "#ff9f1c")); } catch (IllegalArgumentException x) { e.color = Pixel.ORANGE; }
                s.events.add(e);
            }
            JSONArray ts = o.optJSONArray("tasks");
            for (int i = 0; ts != null && i < ts.length(); i++) {
                JSONObject t = ts.getJSONObject(i);
                s.taskDays.add(t.optString("d"));
                s.tasks.add(new String[] { t.optString("t", ""), t.optString("d") });
            }
            s.empty = false;
        } catch (Exception ignored) { }
        return s;
    }

    static String ymd(Calendar c) {
        return String.format(Locale.US, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
    }

    /** One line in the widget's day box. time is "" for all-day things and tasks. */
    public static final class Item {
        public final String time, title, detail; public final boolean task;
        Item(String time, String title, String detail, boolean task) { this.time = time; this.title = title; this.detail = detail; this.task = task; }
    }

    /** Everything on a day (YYYY-MM-DD), like the landing mock's box: events (all-day first, then by time), then tasks due. */
    public List<Item> on(String day) {
        String[] p = day.split("-");
        Calendar d = Calendar.getInstance();
        d.clear();
        d.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]));
        long start = d.getTimeInMillis();
        d.add(Calendar.DAY_OF_MONTH, 1);
        long end = d.getTimeInMillis();
        List<Event> hits = new ArrayList<>();
        for (Event e : events) {
            if (e.allDay ? e.start < end && e.end > start : e.start < end && (e.end > start || e.start >= start)) hits.add(e);
        }
        hits.sort((a, b) -> a.allDay != b.allDay ? (a.allDay ? -1 : 1) : Long.compare(a.start, b.start));
        List<Item> out = new ArrayList<>();
        for (Event e : hits) {
            String time = e.allDay ? "" : e.start < start ? "…" : clock(e.start);
            StringBuilder detail = new StringBuilder();
            if (!e.allDay && e.start >= start) detail.append(clock(e.start)).append("–").append(clock(e.end));
            if (!e.location.isEmpty()) detail.append(detail.length() > 0 ? " · " : "").append(e.location);
            if (!e.notes.isEmpty()) detail.append(detail.length() > 0 ? " · " : "").append(e.notes);
            out.add(new Item(time, e.title, detail.toString(), false));
        }
        for (String[] t : tasks) if (day.equals(t[1])) out.add(new Item("", t[0], "", true));
        return out;
    }

    /** Titles of what's on today. */
    public List<String> today() {
        List<String> out = new ArrayList<>();
        for (Item i : on(ymd(Calendar.getInstance()))) out.add(i.title);
        return out;
    }

    /** "9:30A" / "9A" (or "09:30" on a 24-hour clock), like the app. */
    String clock(long ms) {
        Calendar d = Calendar.getInstance();
        d.setTimeInMillis(ms);
        int h = d.get(Calendar.HOUR_OF_DAY), mi = d.get(Calendar.MINUTE);
        if (h24) return String.format(Locale.US, "%02d:%02d", h, mi);
        return (h % 12 == 0 ? 12 : h % 12) + (mi > 0 ? String.format(Locale.US, ":%02d", mi) : "") + (h < 12 ? "A" : "P");
    }

    /** Every day (YYYY-MM-DD) that has something on it. */
    public Set<String> busyDays() {
        Set<String> out = new HashSet<>(taskDays);
        Calendar c = Calendar.getInstance();
        for (Event e : events) {
            if (e.allDay) {
                // All-day: from its first day, one square per day it covers.
                String[] p = e.day.split("-");
                if (p.length != 3) continue;
                c.clear();
                c.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]));
                long days = Math.max(1, Math.round((e.end - e.start) / 86400000.0));
                for (int i = 0; i < days && i < 62; i++) { out.add(ymd(c)); c.add(Calendar.DAY_OF_MONTH, 1); }
            } else {
                c.setTimeInMillis(e.start);
                out.add(ymd(c));
            }
        }
        return out;
    }
}
