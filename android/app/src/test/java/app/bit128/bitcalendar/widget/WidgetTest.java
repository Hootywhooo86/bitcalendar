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

    @Test public void monthDrawsAndTapsOpenTheDay() throws Exception {
        Snapshot.save(c, sample());
        int id = widgets.createWidget(MonthWidget.class, R.layout.widget_month);
        View v = widgets.getViewFor(id);
        Bitmap b = bitmap(v);
        save(b, "month.png");
        assertTrue(b.getWidth() > 100 && b.getHeight() > 100);
        // Square 10 of the grid → the day it shows.
        Calendar first = MonthWidget.gridStart(firstOfMonth(), 0);
        first.add(Calendar.DAY_OF_MONTH, 10);
        v.findViewById(c.getResources().getIdentifier("c10", "id", c.getPackageName())).performClick();
        Intent opened = shadowOf((Application) c).getNextStartedActivity();
        assertNotNull("tapping a day opens the app", opened);
        assertEquals("app.bit128.bitcalendar://open?day=" + Snapshot.ymd(first), opened.getDataString());
    }

    @Test public void monthArrowsFlipTheMonth() throws Exception {
        Snapshot.save(c, sample());
        int id = widgets.createWidget(MonthWidget.class, R.layout.widget_month);
        widgets.getViewFor(id).findViewById(R.id.hdr_next).performClick();
        shadowOf(android.os.Looper.getMainLooper()).idle();
        new MonthWidget().onReceive(c, shadowOf((Application) c).getBroadcastIntents().get(shadowOf((Application) c).getBroadcastIntents().size() - 1));
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
        ev.put(event("Standup", now + 25 * 60_000L, now + 40 * 60_000L, false, "#46d6db"));
        ev.put(event("Design review", now + (5 * 60 + 10) * 60_000L, now + 6 * 3600_000L, false, "#9fe1e7"));
        Calendar tm = (Calendar) today.clone(); tm.add(Calendar.DAY_OF_MONTH, 1);
        Calendar tm2 = (Calendar) tm.clone(); tm2.add(Calendar.DAY_OF_MONTH, 1);
        ev.put(event("Nana's birthday", tm.getTimeInMillis(), tm2.getTimeInMillis(), true, "#ff9f1c").put("d", Snapshot.ymd(tm)));
        ev.put(event("Camping trip", tm.getTimeInMillis() + 3 * 86400000L, tm.getTimeInMillis() + 6 * 86400000L, true, "#f691b2")
            .put("d", Snapshot.ymd(plus(tm, 3))));
        return new JSONObject().put("v", 1).put("at", now).put("weekStart", 0).put("h24", false).put("events", ev)
            .put("tasks", new JSONArray().put(new JSONObject().put("t", "Pay rent").put("d", Snapshot.ymd(plus(today, 6))))).toString();
    }

    private static Calendar plus(Calendar c, int days) { Calendar x = (Calendar) c.clone(); x.add(Calendar.DAY_OF_MONTH, days); return x; }

    private static JSONObject event(String t, long s, long e, boolean allDay, String color) throws Exception {
        Calendar d = Calendar.getInstance(); d.setTimeInMillis(s);
        return new JSONObject().put("t", t).put("s", s).put("e", e).put("a", allDay ? 1 : 0).put("c", color).put("d", Snapshot.ymd(d));
    }
}
