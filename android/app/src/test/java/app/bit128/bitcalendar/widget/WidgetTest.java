package app.bit128.bitcalendar.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.Application;
import android.appwidget.AppWidgetManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.drawable.BitmapDrawable;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.RemoteViews;
import androidx.test.core.app.ApplicationProvider;
import java.io.File;
import java.io.FileOutputStream;
import java.util.Calendar;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowAppWidgetManager;
import app.bit128.bitcalendar.R;

/** The widgets as the home screen sees them: inflated as RemoteViews, drawn, tapped. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 36)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
public class WidgetTest {
    private Context c;
    private ShadowAppWidgetManager widgets;

    @Before
    public void setUp() {
        c = ApplicationProvider.getApplicationContext();
        widgets = shadowOf(AppWidgetManager.getInstance(c));
        Snapshot.prefs(c).edit().clear().commit();
    }

    // Launchers only inflate an allow-list of view classes; anything else is "Can't load widget".
    @Test public void monthLayoutLoadsOnAHomeScreen() {
        View v = new RemoteViews(c.getPackageName(), R.layout.widget_month).apply(c, new FrameLayout(c));
        assertNotNull(v.findViewById(R.id.widget_image));
        assertNotNull(v.findViewById(c.getResources().getIdentifier("c41", "id", c.getPackageName())));
    }

    @Test public void upNextLayoutLoadsOnAHomeScreen() {
        View v = new RemoteViews(c.getPackageName(), R.layout.widget_upnext).apply(c, new FrameLayout(c));
        assertNotNull(v.findViewById(R.id.widget_image));
    }

    // Like the web page: tap a day, the box below describes it; tap the box to open that day.
    @Test public void tappingADayDescribesItBelow() throws Exception {
        Snapshot.save(c, sample());
        int id = widgets.createWidget(MonthWidget.class, R.layout.widget_month);
        View v = widgets.getViewFor(id);
        Bitmap b = bitmap(v);
        save(b, "month.png");
        assertTrue(b.getWidth() > 100 && b.getHeight() > 100);
        Calendar tomorrow = plus(Calendar.getInstance(), 1);
        int cell = (int) Math.round((noon(tomorrow) - noon(MonthWidget.gridStart(firstOfMonth(), 0))) / 86400000.0);
        if (cell >= 0 && cell < 42) {
            v.findViewById(c.getResources().getIdentifier("c" + cell, "id", c.getPackageName())).performClick();
            deliverLastBroadcast();
            assertEquals(Snapshot.ymd(tomorrow), MonthWidget.selected(Snapshot.prefs(c), id));
            v = widgets.getViewFor(id);
            save(bitmap(v), "month-picked.png");
        }
        v.findViewById(R.id.today_panel).performClick();
        Intent opened = shadowOf((Application) c).getNextStartedActivity();
        assertNotNull("tapping the box opens the app", opened);
        assertEquals("app.bit128.bitcalendar://open?day=" + MonthWidget.selected(Snapshot.prefs(c), id), opened.getDataString());
    }

    @Test public void dayBoxDescribesEverything() throws Exception {
        Snapshot.save(c, sample());
        java.util.List<Snapshot.Item> items = Snapshot.load(c).on(Snapshot.ymd(Calendar.getInstance()));
        assertEquals("Standup", items.get(0).title);
        assertTrue(items.get(0).detail, items.get(0).detail.contains("Room 4") && items.get(0).detail.contains("bring notes"));
        assertTrue(items.get(0).detail.contains("–"));
    }

    private void deliverLastBroadcast() {
        java.util.List<Intent> sent = shadowOf((Application) c).getBroadcastIntents();
        new MonthWidget().onReceive(c, sent.get(sent.size() - 1));
    }

    private static long noon(Calendar day) {
        Calendar d = (Calendar) day.clone();
        d.set(Calendar.HOUR_OF_DAY, 12); d.set(Calendar.MINUTE, 0); d.set(Calendar.SECOND, 0); d.set(Calendar.MILLISECOND, 0);
        return d.getTimeInMillis();
    }

    // The landing page mock, on a home screen: TODAY box with what's on, dot on the 25th.
    @Test public void monthLooksLikeTheMock() throws Exception {
        long now = System.currentTimeMillis();
        Calendar today = Calendar.getInstance();
        today.set(Calendar.HOUR_OF_DAY, 7); today.set(Calendar.MINUTE, 0);
        Calendar sat = plus(today, (Calendar.SATURDAY - today.get(Calendar.DAY_OF_WEEK) + 7) % 7);
        JSONArray ev = new JSONArray()
            .put(event("Morning quest: log workout", today.getTimeInMillis(), today.getTimeInMillis() + 3600_000L, false, "#ff9f1c"))
            .put(event("Birthday dinner @ Nana's", sat.getTimeInMillis() + 10 * 3600_000L, sat.getTimeInMillis() + 12 * 3600_000L, false, "#ff9f1c"));
        Snapshot.save(c, new JSONObject().put("v", 1).put("at", now).put("weekStart", 0).put("events", ev)
            .put("tasks", new JSONArray().put(new JSONObject().put("t", "Call mom back").put("d", Snapshot.ymd(Calendar.getInstance())))).toString());
        assertEquals(java.util.Arrays.asList("Morning quest: log workout", "Call mom back"), Snapshot.load(c).today());
        int id = widgets.createWidget(MonthWidget.class, R.layout.widget_month);
        View v = widgets.getViewFor(id);
        save(bitmap(v), "month-mock.png");
        // Rows the month doesn't need are gone, so the tap zones match the drawing.
        int rows = MonthWidget.weeks(firstOfMonth(), MonthWidget.gridStart(firstOfMonth(), 0));
        assertEquals(rows > 5 ? View.VISIBLE : View.GONE, v.findViewById(R.id.r5).getVisibility());
        v.findViewById(R.id.today_panel).performClick();
        Intent opened = shadowOf((Application) c).getNextStartedActivity();
        assertEquals("app.bit128.bitcalendar://open?day=" + Snapshot.ymd(Calendar.getInstance()), opened.getDataString());
    }

    @Test public void weekRowsFitTheMonth() {
        assertEquals(4, weeksOf(2026, Calendar.FEBRUARY, 0)); // starts Sunday, 28 days
        assertEquals(6, weeksOf(2026, Calendar.AUGUST, 0));   // starts Saturday, 31 days
        assertEquals(5, weeksOf(2026, Calendar.OCTOBER, 0));
        assertEquals(5, weeksOf(2026, Calendar.FEBRUARY, 1)); // Monday weeks push it to 5
    }

    private static int weeksOf(int y, int m, int weekStart) {
        Calendar month = Calendar.getInstance();
        month.clear();
        month.set(y, m, 1);
        return MonthWidget.weeks(month, MonthWidget.gridStart(month, weekStart));
    }

    @Test public void monthArrowsFlipTheMonth() throws Exception {
        Snapshot.save(c, sample());
        int id = widgets.createWidget(MonthWidget.class, R.layout.widget_month);
        widgets.getViewFor(id).findViewById(R.id.hdr_next).performClick();
        shadowOf(android.os.Looper.getMainLooper()).idle();
        deliverLastBroadcast();
        assertEquals(1, Snapshot.prefs(c).getInt("off_" + id, 0));
        save(bitmap(widgets.getViewFor(id)), "month-next.png");
    }

    @Test public void monthWithNothingSyncedYetStillDraws() throws Exception {
        int id = widgets.createWidget(MonthWidget.class, R.layout.widget_month);
        save(bitmap(widgets.getViewFor(id)), "month-empty.png");
    }

    @Test public void upNextDrawsCountdowns() throws Exception {
        Snapshot.save(c, sample());
        int id = widgets.createWidget(UpNextWidget.class, R.layout.widget_upnext);
        View v = widgets.getViewFor(id);
        save(bitmap(v), "upnext.png");
        v.findViewById(R.id.widget_root).performClick();
        Intent opened = shadowOf((Application) c).getNextStartedActivity();
        assertNotNull(opened);
        assertTrue(opened.getDataString().startsWith("app.bit128.bitcalendar://open?day="));
    }

    @Test public void upNextEmpty() throws Exception {
        int id = widgets.createWidget(UpNextWidget.class, R.layout.widget_upnext);
        save(bitmap(widgets.getViewFor(id)), "upnext-empty.png");
    }

    @Test public void countdownText() {
        long now = System.currentTimeMillis();
        Snapshot.Event e = new Snapshot.Event();
        e.start = now + 25 * 60_000L; e.end = e.start + 3600_000L;
        assertEquals("IN 25M", UpNextWidget.countdown(e, now));
        e.start = now + (5 * 60 + 10) * 60_000L;
        assertEquals("IN 5H 10M", UpNextWidget.countdown(e, now));
        e.start = now - 60_000L;
        assertEquals("NOW", UpNextWidget.countdown(e, now));
    }

    // ---- helpers ----

    private static Calendar firstOfMonth() {
        Calendar m = Calendar.getInstance();
        m.set(Calendar.DAY_OF_MONTH, 1);
        return m;
    }

    private static Bitmap bitmap(View v) {
        ImageView img = v.findViewById(R.id.widget_image);
        assertNotNull("widget drew an image", img.getDrawable());
        return ((BitmapDrawable) img.getDrawable()).getBitmap();
    }

    private static void save(Bitmap b, String name) throws Exception {
        File dir = new File(System.getProperty("bitcal.out", "build/widget-renders"));
        dir.mkdirs();
        try (FileOutputStream out = new FileOutputStream(new File(dir, name))) { b.compress(Bitmap.CompressFormat.PNG, 100, out); }
    }

    /** What the app would send: a few events around now, like app.js syncDevice(). */
    private static String sample() throws Exception {
        long now = System.currentTimeMillis();
        Calendar today = Calendar.getInstance();
        today.set(Calendar.HOUR_OF_DAY, 0); today.set(Calendar.MINUTE, 0); today.set(Calendar.SECOND, 0); today.set(Calendar.MILLISECOND, 0);
        JSONArray ev = new JSONArray();
        long soon = Math.min(now + 25 * 60_000L, endOfToday() - 20 * 60_000L);
        ev.put(event("Standup", soon, soon + 15 * 60_000L, false, "#46d6db").put("l", "Room 4").put("n", "bring notes from Friday"));
        ev.put(event("Design review", now + (5 * 60 + 10) * 60_000L, now + 6 * 3600_000L, false, "#9fe1e7"));
        Calendar tm = (Calendar) today.clone(); tm.add(Calendar.DAY_OF_MONTH, 1);
        Calendar tm2 = (Calendar) tm.clone(); tm2.add(Calendar.DAY_OF_MONTH, 1);
        ev.put(event("Nana's birthday", tm.getTimeInMillis(), tm2.getTimeInMillis(), true, "#ff9f1c").put("d", Snapshot.ymd(tm)));
        ev.put(event("Dentist", tm.getTimeInMillis() + 15 * 3600_000L, tm.getTimeInMillis() + 16 * 3600_000L, false, "#ff9f1c").put("l", "Main St Dental"));
        ev.put(event("Camping trip", tm.getTimeInMillis() + 3 * 86400000L, tm.getTimeInMillis() + 6 * 86400000L, true, "#f691b2")
            .put("d", Snapshot.ymd(plus(tm, 3))));
        return new JSONObject().put("v", 1).put("at", now).put("weekStart", 0).put("h24", false).put("events", ev)
            .put("tasks", new JSONArray().put(new JSONObject().put("t", "Pay rent").put("d", Snapshot.ymd(plus(today, 6))))).toString();
    }

    private static long endOfToday() {
        Calendar d = Calendar.getInstance();
        d.set(Calendar.HOUR_OF_DAY, 23); d.set(Calendar.MINUTE, 59); d.set(Calendar.SECOND, 0);
        return d.getTimeInMillis();
    }

    private static Calendar plus(Calendar c, int days) { Calendar x = (Calendar) c.clone(); x.add(Calendar.DAY_OF_MONTH, days); return x; }

    private static JSONObject event(String t, long s, long e, boolean allDay, String color) throws Exception {
        Calendar d = Calendar.getInstance(); d.setTimeInMillis(s);
        return new JSONObject().put("t", t).put("s", s).put("e", e).put("a", allDay ? 1 : 0).put("c", color).put("d", Snapshot.ymd(d));
    }
}
