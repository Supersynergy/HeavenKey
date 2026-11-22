package app.heavenkey.heavenkey_mobile

import com.nimbusds.jose.JOSEObjectType
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.ECDSASigner
import com.nimbusds.jose.crypto.ECDSAVerifier
import com.nimbusds.jose.jwk.Curve
import com.nimbusds.jose.jwk.ECKey
import com.nimbusds.jose.util.Base64URL
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import eu.europa.ec.eudi.sdjwt.NimbusSdJwtOps
import eu.europa.ec.eudi.sdjwt.SdJwt
import eu.europa.ec.eudi.sdjwt.vc.ClaimPath
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.security.PrivateKey
import java.time.Instant
import java.util.Date
import java.util.zip.Inflater

internal fun walletNow(): Long = Instant.now().epochSecond

private fun digest(text: String): String = Base64URL.encode(
    MessageDigest.getInstance("SHA-256").digest(text.toByteArray(Charsets.US_ASCII)),
).toString()

internal sealed interface ConsentPlan {
    val link: WalletLink
    val recipient: String
    val target: String
    val expiresAt: Long
    val fingerprint: String
    val kind: String

    data class Issue(
        override val link: WalletLink,
        override val recipient: String,
        override val target: String,
        override val expiresAt: Long,
        override val fingerprint: String,
        val code: String,
    ) : ConsentPlan {
        override val kind = "issuance"
    }

    data class Present(
        override val link: WalletLink,
        override val recipient: String,
        override val target: String,
        override val expiresAt: Long,
        override val fingerprint: String,
        override val kind: String,
        val credentialId: String,
        val claims: Map<String, String>,
        val operation: Map<String, Any>,
        val nonce: String,
        val state: String,
        val transactionHash: String?,
    ) : ConsentPlan

    fun summary(): Map<String, Any> = mapOf(
        "id" to link.id, "kind" to kind, "fingerprint" to fingerprint, "recipient" to recipient,
        "target" to target, "expires_at" to expiresAt, "claims" to ((this as? Present)?.claims ?: emptyMap()),
        "operation" to ((this as? Present)?.operation ?: emptyMap()),
    )
}

internal data class MembershipCredential(
    val original: SdJwt<SignedJWT>,
    val id: String,
    val issuer: String,
    val claims: Map<String, String>,
    val expiresAt: Long,
    val validFrom: Long,
    val statusIndex: Int,
    val holderBound: Boolean,
) {
    fun summary(status: String): Map<String, Any> = mapOf(
        "id" to id, "issuer" to issuer, "org_id" to claims.getValue("org_id"),
        "membership" to claims.getValue("membership"), "expires_at" to expiresAt, "status" to status,
    )
}

internal class MembershipProtocol(private val profile: WalletProfile, private val store: WalletStore) {
    private val claimNames = setOf("org_id", "membership")
    private val claimPaths = claimNames.map { ClaimPath.claim(it) }.toSet()
    private val origin = profile.origin
    private val requestType = "oauth-authz-req+jwt"
    private val formType = "application/x-www-form-urlencoded"

    private fun times(claims: JSONObject, maxAge: Long, now: Long): Pair<Long, Long> {
        val issued = claims.walletNumber("iat")
        val expires = claims.walletNumber("exp")
        walletCheck(issued in (now - maxAge)..(now + 5) && expires in (now + 1)..(issued + maxAge), "wallet_expired")
        return issued to expires
    }

    fun prepareIssue(link: WalletLink, guard: () -> Unit): ConsentPlan.Issue {
        walletCheck(store.records(guard).none { it.id == link.id }, "wallet_already_received")
        val raw = profile.request(link.path, beforeSend = guard)
        val offer = JSONObject(raw)
        offer.onlyKeys("credential_issuer", "credential_configuration_ids", "grants")
        walletCheck(offer.walletString("credential_issuer") == origin)
        val configurations = offer.getJSONArray("credential_configuration_ids")
        walletCheck(configurations.length() == 1 && configurations.getString(0) == MEMBERSHIP_CONFIG)
        val grants = offer.getJSONObject("grants").apply { onlyKeys(PREAUTHORIZED) }
        val grant = grants.getJSONObject(PREAUTHORIZED).apply { onlyKeys("pre-authorized_code") }
        val code = grant.walletString("pre-authorized_code")
        walletCheck(walletSecret.matches(code))
        checkIssuerMetadata(guard)
        return ConsentPlan.Issue(link, origin, "$origin/credential", walletNow() + 90, digest(raw), code)
    }

    private fun checkIssuerMetadata(guard: () -> Unit) {
        val issuer = JSONObject(profile.request("/.well-known/openid-credential-issuer", beforeSend = guard))
        walletCheck(issuer.walletString("credential_issuer") == origin &&
            issuer.walletString("credential_endpoint") == "$origin/credential" &&
            issuer.walletString("nonce_endpoint") == "$origin/nonce")
        issuer.optJSONArray("authorization_servers")?.let {
            walletCheck(it.length() == 1 && it.getString(0) == origin)
        }
        val configuration = issuer.getJSONObject("credential_configurations_supported").getJSONObject(MEMBERSHIP_CONFIG)
        walletCheck(configuration.walletString("format") == "dc+sd-jwt" &&
            configuration.walletString("vct") == WALLET_VCT)
        val methods = configuration.getJSONArray("cryptographic_binding_methods_supported")
        walletCheck((0 until methods.length()).any { methods.getString(it) == "jwk" })
        val algorithms = configuration.getJSONObject("proof_types_supported").getJSONObject("jwt")
            .getJSONArray("proof_signing_alg_values_supported")
        walletCheck((0 until algorithms.length()).any { algorithms.getString(it) == "ES256" })
        val oauth = JSONObject(profile.request("/.well-known/oauth-authorization-server", beforeSend = guard))
        walletCheck(oauth.walletString("issuer") == origin && oauth.walletString("token_endpoint") == "$origin/token")
    }

    fun issue(plan: ConsentPlan.Issue, guard: () -> Unit): WalletReceipt {
        val latest = prepareIssue(plan.link, guard)
        walletCheck(latest.fingerprint == plan.fingerprint, "wallet_changed")
        val token = JSONObject(profile.request("/token", body = walletForm(
            "grant_type" to PREAUTHORIZED, "pre-authorized_code" to plan.code,
        ), contentType = formType, beforeSend = guard))
        walletCheck(token.walletString("token_type").equals("Bearer", ignoreCase = true))
        val access = token.walletString("access_token")
        walletCheck(walletSecret.matches(access))
        val nonce = JSONObject(profile.request("/nonce", body = "", beforeSend = guard)).walletString("c_nonce")
        walletCheck(walletSecret.matches(nonce))
        val id = plan.link.id
        guard()
        val holder = store.createHolder(id)
        var saved = false
        try {
            val proof = sign("openid4vci-proof+jwt", store.privateHolder(id), origin, nonce, holder = holder)
            val request = JSONObject().put("credential_configuration_id", MEMBERSHIP_CONFIG)
                .put("proofs", JSONObject().put("jwt", JSONArray(listOf(proof))))
            val response = JSONObject(profile.request("/credential", body = request.toString(),
                accessToken = access, beforeSend = guard))
            val credentials = response.getJSONArray("credentials")
            walletCheck(credentials.length() == 1)
            val raw = credentials.getJSONObject(0).walletString("credential")
            val record = CredentialRecord(id, raw)
            val membership = credential(record)
            walletCheck(credentialStatus(membership, statusBits(guard)) == "valid", "wallet_invalid_credential")
            val receipt = WalletReceipt(id, plan.kind, null, "issued")
            store.saveCredential(record, receipt, guard)
            saved = true
            return receipt
        } finally {
            if (!saved) store.discardHolder(id)
        }
    }

    fun credential(record: CredentialRecord, requireHolder: Boolean = true): MembershipCredential {
        val raw = record.original
        walletCheck(raw.length <= 32 * 1024 && raw.lastOrNull() == '~', "wallet_invalid_credential")
        val signed = walletVerifyJwt(raw.substringBefore('~'), "dc+sd-jwt", profile.issuerKey)
        val fields = JSONObject(signed.payload.toString())
        walletCheck(fields.keys().asSequence().all {
            it in setOf("iss", "iat", "nbf", "exp", "vct", "cnf", "status", "_sd_alg", "_sd")
        } && fields.walletString("iss") == origin && fields.walletString("vct") == WALLET_VCT &&
            fields.optString("_sd_alg", "sha-256") == "sha-256", "wallet_invalid_credential")
        val cnf = fields.getJSONObject("cnf").apply { onlyKeys("jwk") }
        val boundKey = ECKey.parse(cnf.getJSONObject("jwk").toString())
        walletCheck(boundKey.curve == Curve.P_256 && !boundKey.isPrivate, "wallet_holder_mismatch")
        val deviceKey = if (requireHolder) store.publicHolder(record.id)
            else runCatching { store.publicHolder(record.id) }.getOrNull()
        val holderBound = boundKey.computeThumbprint() == deviceKey?.computeThumbprint()
        if (requireHolder) walletCheck(holderBound, "wallet_holder_mismatch")
        val status = fields.getJSONObject("status").apply { onlyKeys("status_list") }.getJSONObject("status_list")
        status.onlyKeys("idx", "uri")
        val index = status.walletNumber("idx")
        walletCheck(index in 0L..262_143L && status.walletString("uri") == "$origin/status", "wallet_invalid_credential")
        val issued = fields.walletNumber("iat")
        val expires = fields.walletNumber("exp")
        val now = walletNow()
        val notBefore = if (fields.has("nbf")) fields.walletNumber("nbf") else issued
        walletCheck(issued in 1..(now + 5) && expires in (issued + 1)..(issued + 86_400) &&
            notBefore in (issued - 5) until expires, "wallet_invalid_credential")
        val selected = runBlocking {
            with(NimbusSdJwtOps) {
                val jwt = verify(ECDSAVerifier(profile.issuerKey).asJwtVerifier(), raw).getOrThrow()
                val disclosed = jwt.recreateClaimsAndDisclosuresPerClaim()
                walletCheck(claimPaths.all { disclosed.second.containsKey(it) }, "wallet_invalid_credential")
                val claims = claimNames.associateWith { name ->
                    val claim = disclosed.first[name] as? JsonPrimitive ?: throw WalletFailure("wallet_invalid_credential")
                    walletCheck(claim.isString)
                    claim.content
                }
                walletCheck(claims["org_id"] == WALLET_ORG && claims["membership"] == WALLET_MEMBERSHIP,
                    "wallet_invalid_credential")
                MembershipCredential(jwt, record.id, origin, claims, expires, notBefore, index.toInt(), holderBound)
            }
        }
        return selected
    }

    fun statusBits(guard: () -> Unit): ByteArray {
        val raw = profile.request("/status", expectedType = "application/statuslist+jwt", beforeSend = guard)
        val claims = JSONObject(walletVerifyJwt(raw, "statuslist+jwt", profile.issuerKey).payload.toString())
        walletCheck(claims.walletString("iss") == origin && claims.walletString("sub") == "$origin/status")
        val now = walletNow()
        val issued = times(claims, 65, now).first
        walletCheck(issued >= now - 15 && claims.walletNumber("ttl") in 1..60, "invalid_status")
        val list = claims.getJSONObject("status_list").apply { onlyKeys("bits", "lst") }
        walletCheck(list.walletNumber("bits") == 1L)
        return inflateStatus(list.walletString("lst"))
    }

    fun credentialStatus(credential: MembershipCredential, list: ByteArray?): String {
        val now = walletNow()
        if (credential.expiresAt <= now) return "expired"
        if (!credential.holderBound) return "key_lost"
        if (credential.validFrom > now + 5 || list == null || credential.statusIndex / 8 >= list.size)
            return "status_unavailable"
        return if (walletStatusRevoked(list, credential.statusIndex)) "revoked" else "valid"
    }

    fun preparePresentation(link: WalletLink, guard: () -> Unit): ConsentPlan.Present {
        val raw = profile.request(link.path, expectedType = "application/$requestType", beforeSend = guard)
        val fields = walletRequestClaims(raw, profile.verifierKey, profile.verifierClientId, origin, link.id)
        val expires = times(fields, 300, walletNow()).second
        val nonce = fields.walletString("nonce")
        val state = fields.walletString("state")
        walletCheck(walletSecret.matches(nonce) && walletSecret.matches(state))
        checkDcql(fields.getJSONObject("dcql_query"))
        val operation = walletOperation(fields.getJSONObject("hk_operation"), expires)
        val transactionHash = walletTransactionHash(fields, operation, expires)
        val bits = statusBits(guard)
        val selected = store.records(guard).asReversed().firstNotNullOfOrNull { record ->
            runCatching { credential(record) }.getOrNull()?.takeIf { credentialStatus(it, bits) == "valid" }
        } ?: throw WalletFailure("wallet_no_valid_credential")
        return ConsentPlan.Present(link, "Supersynergy · $origin", "$origin/present", expires,
            digest("$raw:${selected.id}"), operation.getValue("kind") as String, selected.id,
            selected.claims, operation, nonce, state, transactionHash)
    }

    private fun checkDcql(dcql: JSONObject) {
        dcql.onlyKeys("credentials")
        val list = dcql.getJSONArray("credentials")
        walletCheck(list.length() == 1)
        val dc = list.getJSONObject(0)
        walletCheck(dc.keys().asSequence().all {
            it in setOf("id", "format", "meta", "claims", "require_cryptographic_holder_binding")
        } && dc.walletString("id") == MEMBERSHIP_CONFIG && dc.walletString("format") == "dc+sd-jwt")
        if (dc.has("require_cryptographic_holder_binding")) walletCheck(dc.get("require_cryptographic_holder_binding") == true)
        val types = dc.getJSONObject("meta").apply { onlyKeys("vct_values") }.getJSONArray("vct_values")
        walletCheck(types.length() == 1 && types.getString(0) == WALLET_VCT)
        val claims = dc.getJSONArray("claims")
        walletCheck(claims.length() == claimNames.size)
        val names = (0 until claims.length()).map {
            val claim = claims.getJSONObject(it)
            claim.onlyKeys("path")
            val path = claim.getJSONArray("path")
            walletCheck(path.length() == 1)
            path.getString(0)
        }
        walletCheck(names.toSet() == claimNames)
    }

    fun present(plan: ConsentPlan.Present, guard: () -> Unit): WalletReceipt {
        val before = preparePresentation(plan.link, guard)
        walletCheck(before == plan, "wallet_changed")
        val record = store.records(guard).singleOrNull { it.id == plan.credentialId }
            ?: throw WalletFailure("wallet_no_valid_credential")
        val selected = credential(record)
        val compact = with(NimbusSdJwtOps) {
            val presentation = selected.original.present(claimPaths) ?: throw WalletFailure("wallet_invalid_credential")
            presentation.serialize()
        }
        guard()
        val kb = sign("kb+jwt", store.privateHolder(selected.id), profile.verifierClientId, plan.nonce,
            sdHash = digest(compact), transactionHash = plan.transactionHash)
        val pending = WalletReceipt(plan.link.id, plan.kind, plan.state, "outcome_unknown")
        store.saveReceipt(pending, guard)
        val response = try {
            val vp = JSONObject().put(MEMBERSHIP_CONFIG, JSONArray(listOf(compact + kb)))
            JSONObject(profile.request("/present", body = walletForm("vp_token" to vp.toString(), "state" to plan.state),
                contentType = formType, beforeSend = guard))
        } catch (_: Exception) {
            return pending
        }
        return receiptResponse(pending, response).also { store.saveReceipt(it, guard) }
    }

    fun reconcile(receipt: WalletReceipt, guard: () -> Unit): WalletReceipt {
        if (receipt.state == null || receipt.status == "expired" ||
            (receipt.status == "verified" && receipt.kind != "invoice.draft.create")) return receipt
        val response = JSONObject(profile.request("/receipt/${receipt.id}", body = walletForm("state" to receipt.state),
            contentType = formType, beforeSend = guard))
        return receiptResponse(receipt, response).also { store.saveReceipt(it, guard) }
    }

    private fun receiptResponse(receipt: WalletReceipt, response: JSONObject): WalletReceipt {
        walletCheck(response.walletString("receipt_id") == receipt.id, "invalid_response")
        val status = response.walletString("status")
        walletCheck(status in setOf("pending", "verified", "expired"), "invalid_response")
        val action = response.optString("action_status").ifEmpty { null }
        walletCheck(action == null || (receipt.kind == "invoice.draft.create" &&
            action in setOf("approved", "executed", "revoked", "expired")), "invalid_response")
        return receipt.copy(status = status, actionStatus = action)
    }

    private fun sign(type: String, key: PrivateKey, audience: String, nonce: String, holder: ECKey? = null,
                     sdHash: String? = null, transactionHash: String? = null): String {
        val header = JWSHeader.Builder(JWSAlgorithm.ES256).type(JOSEObjectType(type))
        if (holder != null) header.jwk(holder)
        val claims = JWTClaimsSet.Builder().audience(audience).claim("nonce", nonce).issueTime(Date())
        if (sdHash != null) claims.claim("sd_hash", sdHash)
        if (transactionHash != null) claims.claim("transaction_data_hashes_alg", "sha-256")
            .claim("transaction_data_hashes", listOf(transactionHash))
        return SignedJWT(header.build(), claims.build()).apply { sign(ECDSASigner(key, Curve.P_256)) }.serialize()
    }
}

internal fun walletStatusRevoked(list: ByteArray, index: Int): Boolean =
    ((list[index / 8].toInt() and 0xff) shr (index % 8) and 1) != 0

internal fun inflateStatus(encoded: String): ByteArray {
    walletCheck(encoded.length in 1..65536 && Regex("[A-Za-z0-9_-]+").matches(encoded), "invalid_status")
    val inflater = Inflater()
    return try {
        inflater.setInput(Base64URL.from(encoded).decode())
        val output = ByteArray(32769)
        var used = 0
        while (!inflater.finished() && used < output.size) {
            val written = inflater.inflate(output, used, output.size - used)
            walletCheck(written > 0 || inflater.finished(), "invalid_status")
            used += written
        }
        walletCheck(inflater.finished() && inflater.remaining == 0 && used in 1..32768, "invalid_status")
        output.copyOf(used)
    } finally {
        inflater.end()
    }
}

internal fun walletVerifyJwt(raw: String, type: String, key: ECKey): SignedJWT {
    val signed = SignedJWT.parse(raw)
    val header = signed.header
    walletCheck(header.algorithm == JWSAlgorithm.ES256 && header.type?.type == type &&
        header.includedParams.all { it in setOf("alg", "typ", "kid") }, "untrusted_signature")
    walletCheck(signed.verify(ECDSAVerifier(key)), "untrusted_signature")
    return signed
}

internal fun walletOperation(raw: JSONObject, requestExpiry: Long): Map<String, Any> {
    val kind = raw.walletString("kind")
    val tenant = raw.walletString("tenant")
    walletCheck(tenant == WALLET_ORG)
    val resource = raw.walletString("resource")
    walletCheck(Regex("[a-zA-Z0-9._-]{1,64}").matches(resource))
    val base = mapOf("kind" to kind, "tenant" to tenant, "resource" to resource)
    return when (kind) {
        "project.access" -> {
            raw.onlyKeys("kind", "tenant", "resource")
            base
        }
        "invoice.draft.create" -> {
            raw.onlyKeys("kind", "tenant", "resource", "agent_id", "amount_minor", "currency", "uses", "expiration")
            val amount = raw.walletNumber("amount_minor")
            val expiry = raw.walletNumber("expiration")
            val agent = raw.walletString("agent_id")
            walletCheck(amount in 1..1_000_000 && raw.walletString("currency") == "EUR" &&
                expiry in (walletNow() + 1)..(requestExpiry + 300) && raw.walletNumber("uses") == 1L &&
                Regex("[a-zA-Z0-9._-]{1,64}").matches(agent))
            base + mapOf("agent_id" to agent, "amount_minor" to amount, "currency" to "EUR",
                "uses" to 1, "expiration" to expiry)
        }
        else -> throw WalletFailure("wallet_unsupported_operation")
    }
}

internal fun walletTransactionHash(fields: JSONObject, operation: Map<String, Any>, expires: Long): String? {
    if (operation["kind"] == "project.access") {
        walletCheck(!fields.has("transaction_data"))
        return null
    }
    val entries = fields.getJSONArray("transaction_data")
    walletCheck(entries.length() == 1)
    val encoded = entries.getString(0)
    walletCheck(encoded.length in 1..4096 && Regex("[A-Za-z0-9_-]+").matches(encoded))
    val transaction = JSONObject(Base64URL.from(encoded).decodeToString())
    walletCheck(transaction.remove("type") == "https://heavenkey.app/transactions/invoice-draft/v1")
    val ids = transaction.remove("credential_ids") as? JSONArray ?: throw WalletFailure("invalid_request")
    val hashes = transaction.remove("transaction_data_hashes_alg") as? JSONArray ?: throw WalletFailure("invalid_request")
    walletCheck(ids.length() == 1 && ids.get(0) == MEMBERSHIP_CONFIG &&
        hashes.length() == 1 && hashes.get(0) == "sha-256")
    walletCheck(walletOperation(transaction, expires) == operation, "wallet_changed")
    return digest(encoded)
}

internal fun walletRequestClaims(raw: String, key: ECKey, clientId: String, origin: String, id: String): JSONObject {
    val fields = JSONObject(walletVerifyJwt(raw, "oauth-authz-req+jwt", key).payload.toString())
    walletCheck(fields.walletString("iss") == clientId &&
        fields.walletString("client_id") == clientId &&
        fields.walletString("aud") == "https://self-issued.me/v2" &&
        fields.walletString("response_uri") == "$origin/present" &&
        fields.walletString("response_type") == "vp_token" && fields.walletString("response_mode") == "direct_post")
    walletCheck(fields.keys().asSequence().all {
        it in setOf("iss", "aud", "client_id", "response_uri", "response_type", "response_mode", "nonce",
            "state", "iat", "exp", "jti", "dcql_query", "hk_operation", "transaction_data")
    })
    walletCheck(fields.walletString("jti") == id)
    return fields
}
