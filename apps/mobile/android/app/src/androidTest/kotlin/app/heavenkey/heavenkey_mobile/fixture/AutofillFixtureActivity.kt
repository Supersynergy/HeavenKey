package app.heavenkey.heavenkey_mobile.fixture

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.autofill.AutofillManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject

class AutofillFixtureActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        var first: EditText? = null
        val inputs = linkedMapOf<String, EditText>()
        fun field(name: String, hint: String, secret: Boolean = false) {
            val input = EditText(this).apply {
                id = View.generateViewId(); contentDescription = "fixture-$name"
                this.hint = name; setAutofillHints(hint)
                inputType = InputType.TYPE_CLASS_TEXT or if (secret) InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_TEXT_VARIATION_NORMAL
                importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
                isSaveEnabled = false
            }
            inputs[name] = input
            form.addView(input)
            if (first == null) first = input
        }
        when (intent.getStringExtra("form")) {
            "signup" -> { field("username", "newUsername"); field("password", "newPassword", true); field("confirmation", "newPassword", true) }
            "login" -> { field("username", "username"); field("password", "password", true) }
            else -> { field("given-name", "personGivenName"); field("email", "emailAddress"); field("city", "postalAddressLocality") }
        }
        // A visible child inside a GONE parent must never be considered fillable.
        val hidden = LinearLayout(this).apply { visibility = View.GONE }
        val hiddenName = EditText(this).apply {
            id = View.generateViewId(); setAutofillHints("personGivenName")
            inputType = InputType.TYPE_CLASS_TEXT
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
        }
        inputs["hidden-name"] = hiddenName; hidden.addView(hiddenName); form.addView(hidden)
        form.addView(Button(this).apply {
            text = "Request synthetic autofill"
            setOnClickListener { first?.let { it.requestFocus(); getSystemService(AutofillManager::class.java).requestAutofill(it) } }
        })
        val result = TextView(this).apply { contentDescription = "fixture-result" }
        form.addView(Button(this).apply {
            text = "Inspect synthetic values"
            setOnClickListener { result.text = JSONObject(inputs.mapValues { it.value.text.toString() }).toString() }
        })
        form.addView(result)
        setContentView(form)
        first?.requestFocus()
    }
}
