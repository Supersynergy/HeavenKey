package app.heavenkey.heavenkey_mobile.fixture;

import android.app.Activity;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.autofill.AutofillManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.LinkedHashMap;
import java.util.Map;

// The test APK can also run as a distinct app/process. Its runtime excludes
// dependencies supplied by the instrumented app, including Kotlin stdlib.
// This fixture intentionally uses only Android/Java platform classes.
public class AutofillFixtureActivity extends Activity {
    private final Map<String, EditText> inputs = new LinkedHashMap<>();
    private EditText first;
    private LinearLayout form;

    private void field(String name, String hint, boolean secret) {
        EditText input = new EditText(this);
        input.setId(View.generateViewId());
        input.setContentDescription("fixture-" + name);
        input.setHint(name);
        input.setAutofillHints(hint);
        input.setInputType(InputType.TYPE_CLASS_TEXT | (secret ? InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_TEXT_VARIATION_NORMAL));
        input.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
        input.setSaveEnabled(false);
        inputs.put(name, input); form.addView(input);
        if (first == null) first = input;
    }

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL); form.setPadding(24, 24, 24, 24);
        String kind = getIntent().getStringExtra("form");
        if ("signup".equals(kind)) {
            field("username", "newUsername", false); field("password", "newPassword", true); field("confirmation", "newPassword", true);
        } else if ("login".equals(kind)) {
            field("username", "username", false); field("password", "password", true);
        } else {
            field("given-name", "personGivenName", false); field("email", "emailAddress", false); field("city", "postalAddressLocality", false);
        }
        LinearLayout hidden = new LinearLayout(this); hidden.setVisibility(View.GONE);
        EditText hiddenName = new EditText(this);
        hiddenName.setId(View.generateViewId()); hiddenName.setAutofillHints("personGivenName");
        hiddenName.setInputType(InputType.TYPE_CLASS_TEXT); hiddenName.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_YES);
        inputs.put("hidden-name", hiddenName); hidden.addView(hiddenName); form.addView(hidden);
        Button request = new Button(this); request.setText("Request synthetic autofill");
        request.setOnClickListener(view -> { first.requestFocus(); getSystemService(AutofillManager.class).requestAutofill(first); });
        form.addView(request);
        TextView result = new TextView(this); result.setContentDescription("fixture-result");
        Button inspect = new Button(this); inspect.setText("Inspect synthetic values");
        inspect.setOnClickListener(view -> {
            Map<String, String> values = new LinkedHashMap<>();
            for (Map.Entry<String, EditText> entry : inputs.entrySet()) values.put(entry.getKey(), entry.getValue().getText().toString());
            result.setText(new JSONObject(values).toString());
        });
        form.addView(inspect); form.addView(result); setContentView(form); first.requestFocus();
    }
}
