package app.bit128.bitcalendar.widget;

import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Path;
import android.os.Bundle;
import android.text.TextPaint;
import android.widget.RemoteViews;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import java.util.Locale;
import app.bit128.bitcalendar.R;

/** "Up next": the next few things with countdowns. Tapping opens the first one's day. */
public class UpNextWidget extends AppWidgetProvider {
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
        // Our own timer, plus the clock or time zone changing and the phone starting up.
        if (Widgets.ACTION_REFRESH.equals(a) || Intent.ACTION_TIME_CHANGED.equals(a) || Intent.ACTION_TIMEZONE_CHANGED.equals(a)
            || Intent.ACTION_BOOT_COMPLETED.equals(a) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(a)) {
            Widgets.updateAll(c);
        }
    }

    static List<Snapshot.Event> upcoming(Snapshot s, long now) {
        List<Snapshot.Event> out = new ArrayList<>();
        for (Snapshot.Event e : s.events) if (e.end > now && e.start < now + 30L * 86400000L) out.add(e);
        out.sort((a, b) -> Long.compare(a.start, b.start));
        return out;
    }

    static void render(Context c, AppWidgetManager m, int id) {
        Snapshot s = Snapshot.load(c);
        long now = System.currentTimeMillis();
        List<Snapshot.Event> next = upcoming(s, now);
        int[] size = Widgets.sizePx(c, m, id, 250, 110);
        RemoteViews rv = new RemoteViews(c.getPackageName(), R.layout.widget_upnext);
        rv.setImageViewBitmap(R.id.widget_image, draw(c, s, next, now, size[0], size[1]));
        String day = null;
        if (!next.isEmpty()) {
            Calendar d = Calendar.getInstance();
            d.setTimeInMillis(Math.max(next.get(0).start, now));
            day = next.get(0).allDay && next.get(0).start <= now ? Snapshot.ymd(Calendar.getInstance()) : Snapshot.ymd(d);
        }
        rv.setOnClickPendingIntent(R.id.widget_root, Widgets.openDay(c, id * 64 + 60, day));
        m.updateAppWidget(id, rv);
    }

    static String countdown(Snapshot.Event e, long now) {
        if (e.allDay) {
            Calendar today = Calendar.getInstance();
            today.set(Calendar.HOUR_OF_DAY, 0); today.set(Calendar.MINUTE, 0); today.set(Calendar.SECOND, 0); today.set(Calendar.MILLISECOND, 0);
            long days = Math.round((e.start - today.getTimeInMillis()) / 86400000.0);
            return days <= 0 ? "TODAY" : days == 1 ? "TOMORROW" : "IN " + days + "D";
        }
        if (e.start <= now) return "NOW";
        long min = (e.start - now + 59_999) / 60_000;
        if (min < 60) return "IN " + min + "M";
        if (min < 1440) return String.format(Locale.US, "IN %dH %02dM", min / 60, min % 60);
        return "IN " + (min / 1440) + "D";
    }

    static String when(Snapshot.Event e, boolean h24) {
        Calendar d = Calendar.getInstance();
        d.setTimeInMillis(e.start);
        String day = Pixel.DOW3[d.get(Calendar.DAY_OF_WEEK) - 1] + " " + Pixel.MONTHS[d.get(Calendar.MONTH)].substring(0, 3) + " " + d.get(Calendar.DAY_OF_MONTH);
        if (e.allDay) return day;
        int h = d.get(Calendar.HOUR_OF_DAY), mi = d.get(Calendar.MINUTE);
        String t = h24 ? String.format(Locale.US, "%02d:%02d", h, mi) : (h % 12 == 0 ? 12 : h % 12) + (mi > 0 ? String.format(Locale.US, ":%02d", mi) : "") + (h < 12 ? "A" : "P");
        return day + " · " + t;
    }

    static Bitmap draw(Context c, Snapshot s, List<Snapshot.Event> next, long now, int w, int h) {
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas cv = new Canvas(b);
        Pixel.frame(cv, w, h, Math.max(3f, Math.min(w, h) * 0.035f));
        float px = w * 0.05f, py = Math.max(h * 0.09f, 8f), inner = w - px * 2;
        float headSize = Math.min(h * 0.09f, w * 0.032f);
        TextPaint head = Pixel.text(c, headSize, Pixel.ORANGE);
        // ▶ UP NEXT (the arrow drawn, the font has no triangle)
        float th = head.descent() - head.ascent();
        Path tri = new Path();
        tri.moveTo(px, py + th * 0.15f); tri.lineTo(px, py + th * 0.85f); tri.lineTo(px + th * 0.6f, py + th * 0.5f); tri.close();
        cv.drawPath(tri, Pixel.fill(Pixel.ORANGE));
        Pixel.line(cv, "UP NEXT", px + th, py, inner * 0.55f, head);
        Calendar today = Calendar.getInstance();
        TextPaint dateP = Pixel.text(c, headSize * 0.85f, Pixel.DIM);
        String date = Pixel.DOW3[today.get(Calendar.DAY_OF_WEEK) - 1] + " " + Pixel.MONTHS[today.get(Calendar.MONTH)].substring(0, 3) + " " + today.get(Calendar.DAY_OF_MONTH);
        cv.drawText(date, px + inner - dateP.measureText(date), py - dateP.ascent() + (th - (dateP.descent() - dateP.ascent())) / 2f, dateP);

        float top = py + th * 1.9f, avail = h - top - py * 0.8f;
        if (s.empty || next.isEmpty()) {
            TextPaint none = Pixel.text(c, headSize, Pixel.MUTE);
            Pixel.line(cv, s.empty ? "open bitcalendar to sync..." : "nothing coming up...", px, top, inner, none);
            return b;
        }
        // Row = countdown line + title line (+ when line if there's room).
        float cdSize = headSize * 0.8f, titleSize = headSize * 1.05f, whenSize = headSize * 0.72f;
        float rowH = (cdSize + titleSize + whenSize) * 1.55f;
        boolean showWhen = true;
        int rows = (int) Math.floor(avail / rowH);
        if (rows < 1) { showWhen = false; rowH = (cdSize + titleSize) * 1.45f; rows = Math.max(1, (int) Math.floor(avail / rowH)); }
        rows = Math.min(rows, Math.min(4, next.size()));
        TextPaint cd = Pixel.text(c, cdSize, Pixel.ORANGE), tt = Pixel.text(c, titleSize, Pixel.TEXT), wh = Pixel.text(c, whenSize, Pixel.DIM);
        for (int i = 0; i < rows; i++) {
            Snapshot.Event e = next.get(i);
            float y = top + i * rowH, bar = Math.max(3f, w * 0.012f);
            cv.drawRect(px, y, px + bar, y + rowH * 0.86f, Pixel.fill(e.color));
            float x = px + bar * 3.2f, tw = inner - bar * 3.2f;
            Pixel.line(cv, countdown(e, now), x, y, tw, cd);
            float ty = y + cdSize * 1.55f;
            Pixel.line(cv, e.title, x, ty, tw, tt);
            if (showWhen) Pixel.line(cv, when(e, s.h24), x, ty + titleSize * 1.5f, tw, wh);
        }
        return b;
    }
}
