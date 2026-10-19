package app.bit128.bitcalendar.widget;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/** The app hands the widgets its calendar (native.js → updateWidget). */
@CapacitorPlugin(name = "BitcalWidget")
public class BitcalWidgetPlugin extends Plugin {
    @PluginMethod
    public void update(PluginCall call) {
        String data = call.getString("data");
        if (data == null) { call.reject("data missing"); return; }
        Snapshot.save(getContext(), data);
        Widgets.updateAll(getContext());
        call.resolve();
    }
}
