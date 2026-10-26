import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate

plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

val releaseSigning = mapOf(
    "storeFile" to providers.environmentVariable("HEAVENKEY_ANDROID_KEYSTORE").orNull,
    "storePassword" to providers.environmentVariable("HEAVENKEY_ANDROID_STORE_PASSWORD").orNull,
    "keyAlias" to providers.environmentVariable("HEAVENKEY_ANDROID_KEY_ALIAS").orNull,
    "keyPassword" to providers.environmentVariable("HEAVENKEY_ANDROID_KEY_PASSWORD").orNull,
    "certificateSha256" to providers.environmentVariable("HEAVENKEY_ANDROID_CERT_SHA256").orNull,
)
val hasReleaseSigning = releaseSigning.values.all { !it.isNullOrBlank() }

val verifyProductionSigning = tasks.register("verifyProductionSigning") {
    group = "verification"
    description = "Reject unsigned releases, debug identities and unexpected signing certificates."
    doLast {
        require(hasReleaseSigning) {
            "Production signing is not configured. Set HEAVENKEY_ANDROID_KEYSTORE, " +
                "HEAVENKEY_ANDROID_STORE_PASSWORD, HEAVENKEY_ANDROID_KEY_ALIAS, " +
                "HEAVENKEY_ANDROID_KEY_PASSWORD and HEAVENKEY_ANDROID_CERT_SHA256. " +
                "No unsigned or debug-signed production build will be created."
        }
        val keystoreFile = file(releaseSigning.getValue("storeFile")!!)
        require(keystoreFile.isFile) { "Production keystore file is unavailable." }
        val password = releaseSigning.getValue("storePassword")!!.toCharArray()
        val store = try { KeyStore.getInstance(keystoreFile, password) }
            finally { password.fill('\u0000') }
        val alias = releaseSigning.getValue("keyAlias")!!
        require(!alias.equals("androiddebugkey", ignoreCase = true) && store.isKeyEntry(alias)) {
            "A private production signing entry is required; debug aliases are forbidden."
        }
        val keyPassword = releaseSigning.getValue("keyPassword")!!.toCharArray()
        val privateKey = try { store.getKey(alias, keyPassword) }
            finally { keyPassword.fill('\u0000') }
        require(privateKey is java.security.PrivateKey) { "A private production signing key is required." }
        val certificate = store.getCertificate(alias) as? X509Certificate
            ?: error("The production signing certificate is unavailable.")
        certificate.checkValidity()
        require(!certificate.subjectX500Principal.name.contains("CN=Android Debug", ignoreCase = true)) {
            "Android debug certificates cannot identify a production release."
        }
        val expected = releaseSigning.getValue("certificateSha256")!!.replace(":", "").lowercase()
        require(Regex("[a-f0-9]{64}").matches(expected)) { "A SHA-256 certificate pin is required." }
        val actual = MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        require(actual == expected) { "The signing certificate does not match the production pin." }
    }
}

android {
    namespace = "app.heavenkey.heavenkey_mobile"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = "app.heavenkey.heavenkey_mobile"
        minSdk = 30
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        create("production") {
            if (hasReleaseSigning) {
                storeFile = file(releaseSigning.getValue("storeFile")!!)
                storePassword = releaseSigning.getValue("storePassword")
                keyAlias = releaseSigning.getValue("keyAlias")
                keyPassword = releaseSigning.getValue("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("production")
            isDebuggable = false
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" || it.name == "validateSigningRelease" }.configureEach {
    dependsOn(verifyProductionSigning)
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}

// AndroidX (Google Maven) and cbor-java (Maven Central), both Apache-2.0.
// CBOR is used only to encode authenticator outputs; crypto uses platform JCA.
dependencies {
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("co.nstant.in:cbor:0.9")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.16.1")
    // Align Flutter integration_test's debug-only dependencies with the device
    // runner: AGP resolves the instrumentation APK consistently with the app.
    debugImplementation("androidx.test:runner:1.7.0")
    debugImplementation("androidx.test:core:1.7.0")
    debugImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
    androidTestImplementation("junit:junit:4.13.2")
}
