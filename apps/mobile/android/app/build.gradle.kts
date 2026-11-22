import groovy.json.JsonOutput
import groovy.json.JsonSlurper
import java.net.URI
import java.util.Base64
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.security.cert.CertificateFactory

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
// Preview is a separate app identity and distribution channel, never a fallback
// signature for app.heavenkey.heavenkey_mobile. The production verifier rejects it.
val isPreview = providers.environmentVariable("HEAVENKEY_ANDROID_PREVIEW").orNull == "true"

// Only a test variant can receive operator-provisioned public trust anchors.
val walletProfile = providers.environmentVariable("HEAVENKEY_WALLET_PROFILE").orNull?.let(::file)
fun publicWalletProfile(file: File): String {
    require(file.isFile && file.length() in 1..16_384) { "The test wallet profile is missing or too large." }
    val config = runCatching { JsonSlurper().parse(file) }.getOrNull() as? Map<*, *>
        ?: error("Invalid public wallet profile.")
    val required = setOf("origin", "verifierClientId", "issuerJwk", "verifierJwk")
    require(config.keys == required || config.keys == required + "tlsCa") { "Invalid public wallet profile fields." }
    val origin = config["origin"] as? String ?: error("Missing wallet origin.")
    val url = runCatching { URI(origin) }.getOrNull() ?: error("Invalid wallet HTTPS origin.")
    require(url.scheme == "https" && url.host != null && url.userInfo == null &&
        url.rawPath.isNullOrEmpty() && url.rawQuery == null && url.rawFragment == null &&
        (url.port == -1 || url.port in 1..65535)) { "Invalid wallet HTTPS origin." }
    val verifier = config["verifierClientId"] as? String ?: error("Missing wallet verifier client id.")
    require(Regex("[A-Za-z0-9._-]{1,128}").matches(verifier)) { "Invalid wallet verifier client id." }
    fun publicKey(field: String): Map<String, String> {
        val key = config[field] as? Map<*, *> ?: error("Invalid wallet public key.")
        val publicFields = setOf("kty", "crv", "x", "y")
        require(key.keys.containsAll(publicFields) && (key.keys - publicFields).all { it == "kid" || it == "alg" }) {
            "Wallet key contains non-public or unsupported fields."
        }
        require(key["kty"] == "EC" && key["crv"] == "P-256" && (!key.containsKey("alg") || key["alg"] == "ES256")) {
            "Wallet key must be a public ES256 key."
        }
        val result = publicFields.associateWith { name -> key[name] as? String ?: error("Invalid wallet key value.") }
        require(listOf("x", "y").all { Regex("[A-Za-z0-9_-]{43}").matches(result.getValue(it)) }) {
            "Invalid wallet EC coordinates."
        }
        return result
    }
    val issuer = publicKey("issuerJwk")
    val verifierKey = publicKey("verifierJwk")
    require(issuer != verifierKey) { "Wallet issuer and verifier require separate public keys." }
    val sanitized = mutableMapOf<String, Any>("origin" to origin, "verifierClientId" to verifier,
        "issuerJwk" to issuer, "verifierJwk" to verifierKey)
    if (config.containsKey("tlsCa")) {
        val pem = (config["tlsCa"] as? String)?.trim() ?: error("Invalid wallet HTTPS CA certificate.")
        require(Regex("-----BEGIN CERTIFICATE-----[\\r\\n]+[A-Za-z0-9+/=\\r\\n]+-----END CERTIFICATE-----").matches(pem)) {
            "The wallet TLS trust field may contain exactly one public certificate."
        }
        val certificate = runCatching {
            CertificateFactory.getInstance("X.509").generateCertificate(pem.byteInputStream())
        }.getOrNull() as? X509Certificate ?: error("Invalid wallet HTTPS CA certificate.")
        require(certificate.basicConstraints >= 0) { "The wallet TLS trust certificate must be a CA." }
        sanitized["tlsCa"] = pem
    }
    return JsonOutput.toJson(sanitized)
}

androidComponents.onVariants { variant ->
    val configured = walletProfile != null && (variant.buildType == "debug" || isPreview)
    val encoded = if (configured) {
        Base64.getEncoder().encodeToString(publicWalletProfile(walletProfile!!).toByteArray(Charsets.UTF_8))
    } else ""
    requireNotNull(variant.buildConfigFields).put(
        "WALLET_PROFILE_BASE64",
        com.android.build.api.variant.BuildConfigField("String", "\"$encoded\"", null),
    )
    variant.manifestPlaceholders.put("heavenKeyWalletEnabled", configured.toString())
}

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
    buildFeatures.buildConfig = true
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        applicationId = if (isPreview) "app.heavenkey.heavenkey_mobile.preview" else "app.heavenkey.heavenkey_mobile"
        manifestPlaceholders["heavenKeyLabel"] = if (isPreview) "HeavenKey Vorschau" else "HeavenKey"
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
            signingConfig = signingConfigs.getByName(if (isPreview) "debug" else "production")
            if (isPreview) versionNameSuffix = "-preview"
            isDebuggable = false
        }
    }
}

tasks.matching { it.name == "preReleaseBuild" || it.name == "validateSigningRelease" }.configureEach {
    if (!isPreview) dependsOn(verifyProductionSigning)
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
    implementation("androidx.autofill:autofill:1.3.0")
    implementation("androidx.credentials:credentials:1.6.0")
    implementation("co.nstant.in:cbor:0.9")
    implementation("com.nimbusds:nimbus-jose-jwt:10.10")
    implementation("eu.europa.ec.eudi:eudi-lib-jvm-sdjwt-kt:0.21.0")
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
