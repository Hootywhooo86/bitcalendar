package app.bit128.bitcalendar;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import app.bit128.bitcalendar.widget.BitcalWidgetPlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(BitcalWidgetPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
