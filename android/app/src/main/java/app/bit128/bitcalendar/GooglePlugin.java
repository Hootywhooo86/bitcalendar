package app.bit128.bitcalendar;

import android.accounts.Account;
import android.app.Activity;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;
import java.util.Arrays;
import java.util.List;

/**
 * Google sign-in the Android way: the phone's own account picker and consent screen (Google blocks
 * sign-in inside app web views). Hands back an access token for Calendar + Tasks; asking again with
 * interactive=false gets a fresh one without showing anything, so Google keeps syncing.
 * Google recognizes the app by its package name + signing key (README → Android app → Google).
 */
@CapacitorPlugin(name = "BitcalGoogle")
public class GooglePlugin extends Plugin {
    private static final List<Scope> SCOPES = Arrays.asList(
        new Scope("https://www.googleapis.com/auth/calendar"),
        new Scope("https://www.googleapis.com/auth/tasks"),
        new Scope("openid"), new Scope("email"), new Scope("profile"));

    private ActivityResultLauncher<IntentSenderRequest> consent;
    private PluginCall waiting;

    @Override
    public void load() {
        // Registered by key (no lifecycle owner needed), so it works after the activity has started.
        consent = getActivity().getActivityResultRegistry().register("bitcal-google", new ActivityResultContracts.StartIntentSenderForResult(), res -> {
            PluginCall call = waiting;
            waiting = null;
            if (call == null) return;
            if (res.getResultCode() != Activity.RESULT_OK) { call.reject("Google sign-in was cancelled"); return; }
            try { send(call, Identity.getAuthorizationClient(getActivity()).getAuthorizationResultFromIntent(res.getData())); }
            catch (ApiException e) { call.reject(explain(e)); }
        });
    }

    @PluginMethod
    public void authorize(PluginCall call) {
        boolean interactive = Boolean.TRUE.equals(call.getBoolean("interactive", true));
        String email = call.getString("email");
        AuthorizationRequest.Builder req = AuthorizationRequest.builder().setRequestedScopes(SCOPES);
        if (email != null && !email.isEmpty()) req.setAccount(new Account(email, "com.google"));
        Identity.getAuthorizationClient(getActivity()).authorize(req.build())
            .addOnSuccessListener(r -> {
                if (!r.hasResolution()) { send(call, r); return; }
                // Needs the person: account picker / consent screen.
                if (!interactive) { call.reject("Google needs you to sign in again", "NEEDS_CONSENT"); return; }
                if (waiting != null) waiting.reject("Google sign-in was restarted");
                waiting = call;
                consent.launch(new IntentSenderRequest.Builder(r.getPendingIntent().getIntentSender()).build());
            })
            .addOnFailureListener(e -> call.reject(e instanceof ApiException ? explain((ApiException) e) : String.valueOf(e.getMessage())));
    }

    private static void send(PluginCall call, AuthorizationResult r) {
        if (r.getAccessToken() == null) { call.reject("Google didn't hand over access"); return; }
        JSObject o = new JSObject();
        o.put("access_token", r.getAccessToken());
        o.put("expires_in", 3300); // Google's tokens last an hour; ask again a little before
        o.put("scope", String.join(" ", r.getGrantedScopes()));
        call.resolve(o);
    }

    private static String explain(ApiException e) {
        if (e.getStatusCode() == CommonStatusCodes.DEVELOPER_ERROR)
            return "Google doesn't know this app yet: add an Android OAuth client for app.bit128.bitcalendar with the app's SHA-1 (README → Android app → Google)";
        if (e.getStatusCode() == CommonStatusCodes.CANCELED) return "Google sign-in was cancelled";
        if (e.getStatusCode() == CommonStatusCodes.NETWORK_ERROR) return "No connection to Google";
        return "Google sign-in failed (" + CommonStatusCodes.getStatusCodeString(e.getStatusCode()) + ")";
    }
}
