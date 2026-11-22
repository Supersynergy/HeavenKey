package app.heavenkey.heavenkey_mobile

import com.nimbusds.jose.JOSEObjectType
import com.nimbusds.jose.JWSAlgorithm
import com.nimbusds.jose.JWSHeader
import com.nimbusds.jose.crypto.ECDSASigner
import com.nimbusds.jose.crypto.MACSigner
import com.nimbusds.jose.jwk.Curve
import com.nimbusds.jose.jwk.gen.ECKeyGenerator
import com.nimbusds.jose.util.Base64URL
import com.nimbusds.jwt.JWTClaimsSet
import com.nimbusds.jwt.SignedJWT
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.zip.Deflater

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [30], manifest = Config.NONE)
class WalletPolicyTest {
    private val origin = "https://127.0.0.1:8443"
    private val verifierId = "heavenkey-membership-verifier"
    private val id = "e7a9ba0b-fc35-453a-b00a-534a061074de"
    private val issuer = ECKeyGenerator(Curve.P_256).generate()
    private val verifier = ECKeyGenerator(Curve.P_256).generate()

    private fun encode(text: String) = URLEncoder.encode(text, "UTF-8")
    private fun configuration() = JSONObject().put("origin", origin).put("verifierClientId", verifierId)
        .put("issuerJwk", JSONObject(issuer.toPublicJWK().toJSONString()))
        .put("verifierJwk", JSONObject(verifier.toPublicJWK().toJSONString()))

    @Test fun linksAllowOnlyTheProvisionedEndpointsAndExactVerifier() {
        val profile = WalletProfile.parse(configuration().toString())
        val request = encode("$origin/request/$id")
        val launch = "openid4vp://authorize?client_id=$verifierId&request_uri=$request"
        assertEquals(WalletLink(id, false), profile.parseLink(launch))
        assertEquals(WalletLink(id, true),
            profile.parseLink("openid-credential-offer://?credential_offer_uri=${encode("$origin/offer/$id")}"))
        val invalid = listOf(
            launch + "&client_id=$verifierId",
            launch + "#fragment",
            launch.replace("client_id=$verifierId", "client_id=unknown"),
            launch.replace(request, encode("https://127.0.0.1:9443/request/$id")),
            launch.replace(request, encode("$origin/request/../request/$id")),
            launch.replace(request, encode("$origin/request/$id?mutable=1")),
            launch.replace(request, encode("https://user@127.0.0.1:8443/request/$id")),
            launch.replace(request, encode("http://127.0.0.1:8443/request/$id")),
            launch.replace("authorize", "unauthorized"),
        )
        invalid.forEach { assertThrows(WalletFailure::class.java) { profile.parseLink(it) } }
    }

    @Test fun roleKeysAreDistinctAndRequestSignaturesPinRoleAlgorithmAndType() {
        val config = configuration()
        assertThrows(WalletFailure::class.java) {
            WalletProfile.parse(JSONObject(config.toString()).put("issuerJwk", config.getJSONObject("verifierJwk")).toString())
        }
        assertThrows(WalletFailure::class.java) {
            WalletProfile.parse(JSONObject(config.toString()).put("issuerJwk", JSONObject(issuer.toJSONString())).toString())
        }
        val claims = JWTClaimsSet.Builder().issuer(verifierId).build()
        val requestType = "oauth-authz-req+jwt"
        fun signature(type: String, embeddedKey: Boolean = false): String {
            val header = JWSHeader.Builder(JWSAlgorithm.ES256).type(JOSEObjectType(type))
            if (embeddedKey) header.jwk(verifier.toPublicJWK())
            return SignedJWT(header.build(), claims).apply { sign(ECDSASigner(verifier)) }.serialize()
        }
        val request = signature(requestType)
        assertEquals(verifierId, walletVerifyJwt(request, requestType, verifier.toPublicJWK()).jwtClaimsSet.issuer)
        assertThrows(WalletFailure::class.java) { walletVerifyJwt(request, requestType, issuer.toPublicJWK()) }
        assertThrows(WalletFailure::class.java) { walletVerifyJwt(signature("JWT"), requestType, verifier.toPublicJWK()) }
        assertThrows(WalletFailure::class.java) { walletVerifyJwt(signature(requestType, true), requestType, verifier.toPublicJWK()) }
        val mac = SignedJWT(JWSHeader.Builder(JWSAlgorithm.HS256).type(JOSEObjectType(requestType)).build(), claims)
            .apply { sign(MACSigner(ByteArray(32))) }.serialize()
        assertThrows(WalletFailure::class.java) { walletVerifyJwt(mac, requestType, verifier.toPublicJWK()) }
    }

    @Test fun signedRequestMustBindItsLinkAndFixedReturnEndpoint() {
        fun request(jti: String?, endpoint: String = "$origin/present"): String {
            val claims = JWTClaimsSet.Builder().issuer(verifierId).audience("https://self-issued.me/v2")
                .claim("client_id", verifierId).claim("response_uri", endpoint).claim("response_type", "vp_token")
                .claim("response_mode", "direct_post")
            if (jti != null) claims.jwtID(jti)
            val header = JWSHeader.Builder(JWSAlgorithm.ES256).type(JOSEObjectType("oauth-authz-req+jwt"))
            return SignedJWT(header.build(), claims.build()).apply { sign(ECDSASigner(verifier)) }.serialize()
        }
        fun verify(jwt: String) = walletRequestClaims(jwt, verifier.toPublicJWK(), verifierId, origin, id)
        assertEquals(id, verify(request(id)).walletString("jti"))
        assertThrows(WalletFailure::class.java) { verify(request("bad-id")) }
        assertThrows(Exception::class.java) { verify(request(null)) }
        assertThrows(WalletFailure::class.java) { verify(request(id, "$origin/another-return-channel")) }
    }

    @Test fun unknownReceiptsSurviveNewWorkAndUpdateOnlyTheirOwnRequest() {
        val pending = (0..31).map { WalletReceipt("request-$it", "project.access", "state-$it", "outcome_unknown") }
        val issued = WalletReceipt("new", "issuance", null, "issued")
        assertThrows(WalletFailure::class.java) { walletReceipts(pending, issued) }
        val completed = pending[5].copy(status = "verified")
        val updated = walletReceipts(pending, completed)
        assertEquals(completed, updated[5])
        val newState = walletReceipts(updated, issued)
        assertEquals(32, newState.size)
        assertFalse(completed in newState)
        assertTrue(pending[6] in newState)
        assertEquals(issued, newState.last())
    }

    @Test fun invoiceApprovalRequiresTheHashOfTheSameTypedTransaction() {
        val expiry = walletNow() + 90
        val input = JSONObject(mapOf(
            "kind" to "invoice.draft.create", "tenant" to WALLET_ORG, "resource" to "order-demo-1",
            "agent_id" to "invoice-draft-agent", "amount_minor" to 12_345, "currency" to "EUR",
            "uses" to 1, "expiration" to expiry,
        ))
        val approved = walletOperation(input, expiry)
        val tx = JSONObject(input.toString()).put("type", "https://heavenkey.app/transactions/invoice-draft/v1")
            .put("credential_ids", JSONArray(listOf("membership")))
            .put("transaction_data_hashes_alg", JSONArray(listOf("sha-256")))
        fun encodeTransaction(transaction: JSONObject) = Base64URL.encode(transaction.toString().toByteArray()).toString()
        val encoded = encodeTransaction(tx)
        val request = JSONObject().put("transaction_data", JSONArray(listOf(encoded)))
        val hash = Base64URL.encode(MessageDigest.getInstance("SHA-256").digest(encoded.toByteArray())).toString()
        assertEquals(hash, walletTransactionHash(request, approved, expiry))
        val modified = encodeTransaction(tx.put("amount_minor", 12_346))
        request.put("transaction_data", JSONArray(listOf(modified)))
        assertThrows(WalletFailure::class.java) { walletTransactionHash(request, approved, expiry) }
        val wrongType = JSONObject(input.toString()).put("amount_minor", "12345")
        assertThrows(WalletFailure::class.java) { walletOperation(wrongType, expiry) }
    }

    @Test fun statusUsesLeastSignificantBitsAndBoundsDecompression() {
        fun compressed(raw: ByteArray, extra: ByteArray = byteArrayOf()): String {
            val deflater = Deflater()
            return try {
                deflater.setInput(raw)
                deflater.finish()
                val output = ByteArray(40_000)
                val size = deflater.deflate(output)
                Base64URL.encode(output.copyOf(size) + extra).toString()
            } finally { deflater.end() }
        }
        val valid = byteArrayOf(0x80.toByte(), 0x01)
        val status = inflateStatus(compressed(valid))
        assertArrayEquals(valid, status)
        assertFalse(walletStatusRevoked(status, 0))
        assertTrue(walletStatusRevoked(status, 7))
        assertTrue(walletStatusRevoked(status, 8))
        assertFalse(walletStatusRevoked(status, 9))
        assertThrows(WalletFailure::class.java) { inflateStatus(compressed(ByteArray(32769))) }
        assertThrows(WalletFailure::class.java) { inflateStatus(compressed(valid, byteArrayOf(1))) }
    }
}
