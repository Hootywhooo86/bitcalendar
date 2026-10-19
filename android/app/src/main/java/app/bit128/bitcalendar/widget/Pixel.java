package app.bit128.bitcalendar.widget;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.text.TextUtils;
import android.text.TextPaint;

/** The landing mock's palette and font, for drawing widgets. */
final class Pixel {
    static final int BG = 0xFF0D0D1A, PANEL = 0xFF1A1A2E, DEEP = 0xFF101024, CELL = 0xFF24243C, BTN = 0xFF2B2B45,
        LINE = 0xFF3D3D5C, TEXT = 0xFFF5F5F5, SOFT = 0xFFCFCFCF, DIM = 0xFF9E9E9E, MUTE = 0xFF55556E,
        PURPLE = 0xFFB388FF, ORANGE = 0xFFFF9F1C;
    static final String[] MONTHS = { "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER" };
    static final String[] DOW1 = { "S", "M", "T", "W", "T", "F", "S" };
    static final String[] DOW3 = { "SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT" };

    private static Typeface font;

    static Typeface font(Context c) {
        if (font == null) {
            try { font = Typeface.createFromAsset(c.getAssets(), "public/fonts/PressStart2P.ttf"); }
            catch (RuntimeException e) { font = Typeface.MONOSPACE; }
        }
        return font;
    }

    static TextPaint text(Context c, float size, int color) {
        TextPaint p = new TextPaint(Paint.ANTI_ALIAS_FLAG);
        p.setTypeface(font(c));
        p.setTextSize(size);
        p.setColor(color);
        return p;
    }

    static Paint fill(int color) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setColor(color);
        return p;
    }

    /** The chunky rounded frame every widget sits in. */
    static void frame(Canvas cv, float w, float h, float border) {
        float r = Math.min(w, h) * 0.07f;
        cv.drawRoundRect(new RectF(0, 0, w, h), r, r, fill(LINE));
        cv.drawRoundRect(new RectF(border, border, w - border, h - border), r * 0.8f, r * 0.8f, fill(PANEL));
    }

    /** Text, cut with "…" to fit. y is the top of the line. */
    static void line(Canvas cv, String s, float x, float y, float maxW, TextPaint p) {
        CharSequence cut = TextUtils.ellipsize(s, p, maxW, TextUtils.TruncateAt.END);
        cv.drawText(cut, 0, cut.length(), x, y - p.ascent(), p);
    }

    static void centered(Canvas cv, String s, float cx, float cy, TextPaint p) {
        float tw = p.measureText(s);
        cv.drawText(s, cx - tw / 2f, cy - (p.ascent() + p.descent()) / 2f, p);
    }
}
