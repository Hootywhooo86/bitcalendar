package app.bit128.bitcalendar.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.os.Bundle;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.text.TextUtils;
import android.view.View;
import android.widget.RemoteViews;
import java.util.Calendar;
import java.util.List;
import java.util.Set;
import app.bit128.bitcalendar.R;

/**
 * The month widget, as on the landing page: month grid, today lit up, a dot on busy days,
 * and the TODAY box underneath. Every square opens that day in the app; ◀ ▶ flip months.
 * Drawn as one bitmap; widget_month.xml lays tap zones over it on the same grid, inside MX/MY margins:
 * header 2 units, weekday letters 1, each week 2 (4–6 weeks, as the month needs), TODAY 5.5.
 */
public class MonthWidget extends AppWidgetProvider {
    static final String ACTION_PREV = "app.bit128.bitcalendar.widget.PREV";
    static final String ACTION_NEXT = "app.bit128.bitcalendar.widget.NEXT";
    private static final long OFFSET_KEEP_MS = 15 * 60_000L; // flipped months spring back to now after a while
    static final float PANEL = 5.5f; // includes the 0.6-unit gap above the box
    static final float MX = 0.07f, MY = 0.06f; // margins, as fractions of width / height

    @Override
    public void onUpdate(Context c, AppWidgetManager m, int[] ids) {
        for (int id : ids) render(c, m, id);
        Widgets.scheduleRefresh(c);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context c, AppWidgetManager m, int id, Bundle options) { render(c, m, id); }

    @Override
    public void onReceive(Context c, Intent intent) {
        super.onReceive(c, intent);
        String a = intent.getAction();
        if (!ACTION_PREV.equals(a) && !ACTION_NEXT.equals(a)) return;
        int id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1);
        if (id < 0) return;
        SharedPreferences p = Snapshot.prefs(c);
        int off = offset(p, id) + (ACTION_NEXT.equals(a) ? 1 : -1);
        p.edit().putInt("off_" + id, off).putLong("off_at_" + id, System.currentTimeMillis()).apply();
        render(c, AppWidgetManager.getInstance(c), id);
    }

    private static int offset(SharedPreferences p, int id) {
        if (System.currentTimeMillis() - p.getLong("off_at_" + id, 0) > OFFSET_KEEP_MS) return 0;
        return p.getInt("off_" + id, 0);
    }

    static void render(Context c, AppWidgetManager m, int id) {
        Snapshot s = Snapshot.load(c);
        Calendar month = Calendar.getInstance();
        month.set(Calendar.DAY_OF_MONTH, 1);
        month.add(Calendar.MONTH, offset(Snapshot.prefs(c), id));
        Calendar first = gridStart(month, s.weekStart);
        int rows = weeks(month, first);
        int[] size = Widgets.sizePx(c, m, id, 250, 320);

        RemoteViews rv = new RemoteViews(c.getPackageName(), R.layout.widget_month);
        rv.setImageViewBitmap(R.id.widget_image, draw(c, s, month, first, rows, size[0], size[1]));
        for (int r = 4; r < 6; r++) {
            int rowId = c.getResources().getIdentifier("r" + r, "id", c.getPackageName());
            rv.setViewVisibility(rowId, r < rows ? View.VISIBLE : View.GONE);
        }
        Calendar d = (Calendar) first.clone();
        for (int i = 0; i < 42; i++) {
            int cellId = c.getResources().getIdentifier("c" + i, "id", c.getPackageName());
            rv.setOnClickPendingIntent(cellId, Widgets.openDay(c, id * 64 + i, Snapshot.ymd(d)));
            d.add(Calendar.DAY_OF_MONTH, 1);
        }
        rv.setOnClickPendingIntent(R.id.hdr_title, Widgets.openDay(c, id * 64 + 50, null));
        rv.setOnClickPendingIntent(R.id.today_panel, Widgets.openDay(c, id * 64 + 53, Snapshot.ymd(Calendar.getInstance())));
        rv.setOnClickPendingIntent(R.id.hdr_prev, nav(c, id, ACTION_PREV, 51));
        rv.setOnClickPendingIntent(R.id.hdr_next, nav(c, id, ACTION_NEXT, 52));
        m.updateAppWidget(id, rv);
    }

    private static PendingIntent nav(Context c, int id, String action, int code) {
        Intent i = new Intent(c, MonthWidget.class).setAction(action).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id);
        return PendingIntent.getBroadcast(c, id * 64 + code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static Calendar gridStart(Calendar month, int weekStart) {
        Calendar g = (Calendar) month.clone();
        int dow = g.get(Calendar.DAY_OF_WEEK) - 1; // 0 = Sunday
        g.add(Calendar.DAY_OF_MONTH, -((dow - weekStart + 7) % 7));
        return g;
    }

    /** How many week rows the month needs (4 to 6). */
    static int weeks(Calendar month, Calendar first) {
        Calendar last = (Calendar) month.clone();
        last.set(Calendar.DAY_OF_MONTH, last.getActualMaximum(Calendar.DAY_OF_MONTH));
        long days = Math.round((startOfDay(last) - startOfDay(first)) / 86400000.0) + 1;
        return (int) Math.max(4, Math.min(6, (days + 6) / 7));
    }

    private static long startOfDay(Calendar c) {
        Calendar d = (Calendar) c.clone();
        d.set(Calendar.HOUR_OF_DAY, 12); // noon: DST days are 23 or 25 hours long
        d.set(Calendar.MINUTE, 0); d.set(Calendar.SECOND, 0); d.set(Calendar.MILLISECOND, 0);
        return d.getTimeInMillis();
    }

    static Bitmap draw(Context c, Snapshot s, Calendar month, Calendar first, int rows, int w, int h) {
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(b);
        Pixel.frame(cv, w, h, Math.max(3f, w * 0.018f));
        float px = w * MX, py = h * MY, cw = w * (1 - 2 * MX), ch = h * (1 - 2 * MY);
        float u = ch / (3 + rows * 2 + PANEL), col = cw / 7f;

        // Header: "OCTOBER 2026" + two chunky buttons.
        String title = Pixel.MONTHS[month.get(Calendar.MONTH)] + " " + month.get(Calendar.YEAR);
        TextPaint tp = Pixel.text(c, Math.min(u * 0.55f, col * 0.5f), Pixel.PURPLE);
        while (tp.measureText(title) > col * 4.8f && tp.getTextSize() > 6) tp.setTextSize(tp.getTextSize() - 1);
        Pixel.line(cv, title, px + col * 0.1f, py + u - (tp.descent() - tp.ascent()) / 2f, col * 4.9f, tp);
        button(cv, px + col * 5, py, col, u * 2, true);
        button(cv, px + col * 6, py, col, u * 2, false);

        // Weekday letters.
        TextPaint dp = Pixel.text(c, Math.min(u * 0.45f, col * 0.3f), Pixel.DIM);
        for (int i = 0; i < 7; i++) Pixel.centered(cv, Pixel.DOW1[(i + s.weekStart) % 7], px + col * (i + 0.5f), py + u * 2.5f, dp);

        // Squares.
        Set<String> busy = s.busyDays();
        String today = Snapshot.ymd(Calendar.getInstance());
        float side = Math.min(col, u * 2);
        TextPaint np = Pixel.text(c, side * 0.3f, Pixel.SOFT);
        Paint cell = Pixel.fill(Pixel.CELL), lit = Pixel.fill(Pixel.PURPLE), glow = Pixel.fill(0x55B388FF);
        Calendar d = (Calendar) first.clone();
        for (int i = 0; i < rows * 7; i++) {
            float x = px + col * (i % 7), y = py + u * 3 + u * 2 * (i / 7), gap = col * 0.06f;
            RectF r = new RectF(x + gap, y + gap, x + col - gap, y + u * 2 - gap);
            float rad = side * 0.12f;
            String key = Snapshot.ymd(d);
            boolean isToday = key.equals(today), other = d.get(Calendar.MONTH) != month.get(Calendar.MONTH);
            if (isToday) {
                cv.drawRoundRect(new RectF(r.left - gap * 0.7f, r.top - gap * 0.7f, r.right + gap * 0.7f, r.bottom + gap * 0.7f), rad * 1.3f, rad * 1.3f, glow);
                cv.drawRoundRect(r, rad, rad, lit);
            } else {
                cell.setAlpha(other ? 64 : 255);
                cv.drawRoundRect(r, rad, rad, cell);
            }
            boolean dot = busy.contains(key);
            np.setColor(isToday ? Pixel.BG : Pixel.SOFT);
            np.setAlpha(other && !isToday ? 64 : 255);
            Pixel.centered(cv, String.valueOf(d.get(Calendar.DAY_OF_MONTH)), r.centerX(), dot ? r.centerY() - r.height() * 0.1f : r.centerY(), np);
            if (dot) {
                Paint dp2 = Pixel.fill(isToday ? Pixel.BG : Pixel.ORANGE);
                dp2.setAlpha(other && !isToday ? 64 : 255);
                cv.drawCircle(r.centerX(), r.bottom - r.height() * 0.27f, side * 0.065f, dp2);
            }
            d.add(Calendar.DAY_OF_MONTH, 1);
        }
        todayBox(c, cv, s, px, py + u * (3 + rows * 2 + 0.6f), cw, u * (PANEL - 0.6f), u, col);
        return b;
    }

    /** The TODAY box: dark inset panel, orange title, "+ thing" lines that wrap like the mock. */
    private static void todayBox(Context c, Canvas cv, Snapshot s, float x, float y, float w, float h, float u, float col) {
        float bw = Math.max(2f, col * 0.06f), rad = col * 0.12f;
        cv.drawRoundRect(new RectF(x, y, x + w, y + h), rad, rad, Pixel.fill(Pixel.LINE));
        cv.drawRoundRect(new RectF(x + bw, y + bw, x + w - bw, y + h - bw), rad * 0.7f, rad * 0.7f, Pixel.fill(Pixel.DEEP));
        float pad = col * 0.32f, size = Math.min(u * 0.52f, col * 0.27f);
        TextPaint title = Pixel.text(c, size, Pixel.ORANGE);
        Pixel.line(cv, "TODAY", x + pad, y + pad, w - pad * 2, title);
        float top = y + pad + (title.descent() - title.ascent()) * 1.7f, avail = y + h - pad * 0.8f - top;
        List<String> items = s.today();
        TextPaint tp = Pixel.text(c, size, items.isEmpty() ? Pixel.MUTE : Pixel.SOFT);
        StringBuilder text = new StringBuilder();
        for (String t : items) text.append(text.length() > 0 ? "\n" : "").append("+ ").append(t);
        if (items.isEmpty()) text.append(s.empty ? "open bitcalendar to sync..." : "no quests scheduled...");
        float lineH = (tp.descent() - tp.ascent()) * 1.45f;
        int maxLines = Math.max(1, (int) Math.floor(avail / lineH));
        StaticLayout layout = StaticLayout.Builder.obtain(text, 0, text.length(), tp, (int) (w - pad * 2))
            .setAlignment(Layout.Alignment.ALIGN_NORMAL).setLineSpacing(0, 1.45f).setIncludePad(false)
            .setMaxLines(maxLines).setEllipsize(TextUtils.TruncateAt.END).build();
        cv.save();
        cv.translate(x + pad, top);
        layout.draw(cv);
        cv.restore();
    }

    /** A ◀ / ▶ button like the landing mock's: dark square, darker lip underneath. */
    private static void button(Canvas cv, float x, float y, float w, float h, boolean left) {
        float s = Math.min(w, h) * 0.7f, bx = x + (w - s) / 2f, by = y + (h - s) / 2f, rad = s * 0.18f;
        cv.drawRoundRect(new RectF(bx, by + s * 0.1f, bx + s, by + s + s * 0.1f), rad, rad, Pixel.fill(0xFF17172A));
        cv.drawRoundRect(new RectF(bx, by, bx + s, by + s), rad, rad, Pixel.fill(Pixel.BTN));
        Path t = new Path();
        float cx = bx + s / 2f, cy = by + s / 2f, a = s * 0.18f;
        if (left) { t.moveTo(cx + a * 0.7f, cy - a); t.lineTo(cx + a * 0.7f, cy + a); t.lineTo(cx - a * 0.9f, cy); }
        else { t.moveTo(cx - a * 0.7f, cy - a); t.lineTo(cx - a * 0.7f, cy + a); t.lineTo(cx + a * 0.9f, cy); }
        t.close();
        cv.drawPath(t, Pixel.fill(Pixel.TEXT));
    }
}
