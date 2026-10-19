package app.bit128.bitcalendar.widget;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.DisplayMetrics;
import app.bit128.bitcalendar.MainActivity;

/** Shared bits: redraw everything, how big a widget is, and taps that open the app. */
public final class Widgets {
    static final String SCHEME = "app.bit128.bitcalendar";
    static final String ACTION_REFRESH = "app.bit128.bitcalendar.widget.REFRESH";

    public static void updateAll(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        for (int id : m.getAppWidgetIds(new ComponentName(c, MonthWidget.class))) MonthWidget.render(c, m, id);
        for (int id : m.getAppWidgetIds(new ComponentName(c, UpNextWidget.class))) UpNextWidget.render(c, m, id);
        scheduleRefresh(c);
    }

    /** Countdowns go stale; redraw every few minutes while the phone is awake (never wakes it up). */
    static void scheduleRefresh(Context c) {
        AppWidgetManager m = AppWidgetManager.getInstance(c);
        boolean any = m.getAppWidgetIds(new ComponentName(c, UpNextWidget.class)).length > 0
            || m.getAppWidgetIds(new ComponentName(c, MonthWidget.class)).length > 0;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        Intent i = new Intent(c, UpNextWidget.class).setAction(ACTION_REFRESH);
        PendingIntent pi = PendingIntent.getBroadcast(c, 7001, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        am.cancel(pi);
        if (any) am.set(AlarmManager.RTC, System.currentTimeMillis() + 5 * 60_000L, pi);
    }

    /** Widget size in pixels, from what the launcher reports (portrait: min width × max height). */
    static int[] sizePx(Context c, AppWidgetManager m, int id, int defW, int defH) {
        Bundle o = m.getAppWidgetOptions(id);
        DisplayMetrics dm = c.getResources().getDisplayMetrics();
        int wDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, defW);
        int hDp = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT, defH);
        if (wDp <= 0) wDp = defW;
        if (hDp <= 0) hDp = defH;
        float scale = Math.min(dm.density, 1100f / Math.max(wDp, hDp)); // keep bitmaps small enough for RemoteViews
        return new int[] { Math.max(64, Math.round(wDp * scale)), Math.max(64, Math.round(hDp * scale)) };
    }

    /** Opens the app on a day (YYYY-MM-DD), or today when day is null. */
    static PendingIntent openDay(Context c, int requestCode, String day) {
        Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(SCHEME + "://open" + (day != null ? "?day=" + day : "")), c, MainActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(c, requestCode, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
