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
    }

    public final List<Event> events = new ArrayList<>();
    public final Set<String> taskDays = new HashSet<>();
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
                try { e.color = Color.parseColor(j.optString("c", "#ff9f1c")); } catch (IllegalArgumentException x) { e.color = Pixel.ORANGE; }
                s.events.add(e);
            }
            JSONArray ts = o.optJSONArray("tasks");
            for (int i = 0; ts != null && i < ts.length(); i++) s.taskDays.add(ts.getJSONObject(i).optString("d"));
            s.empty = false;
        } catch (Exception ignored) { }
        return s;
    }

    static String ymd(Calendar c) {
        return String.format(Locale.US, "%04d-%02d-%02d", c.get(Calendar.YEAR), c.get(Calendar.MONTH) + 1, c.get(Calendar.DAY_OF_MONTH));
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
