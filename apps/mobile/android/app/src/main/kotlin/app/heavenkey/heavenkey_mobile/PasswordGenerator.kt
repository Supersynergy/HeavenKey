package app.heavenkey.heavenkey_mobile

import android.content.Context
import java.security.SecureRandom

internal object PasswordGenerator {
    private val random = SecureRandom()
    private val groups = listOf("ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!@#%+-_=?:")
    fun characters(length: Int = 24): String {
        require(length in 16..128)
        val alphabet = groups.joinToString("")
        val result = groups.map { it[random.nextInt(it.length)] }.toMutableList()
        repeat(length - result.size) { result.add(alphabet[random.nextInt(alphabet.length)]) }
        for (index in result.lastIndex downTo 1) {
            val other = random.nextInt(index + 1)
            val old = result[index]; result[index] = result[other]; result[other] = old
        }
        return result.joinToString("")
    }

    fun wordlist(text: String): List<String> {
        val rows = text.lineSequence().filter { it.isNotBlank() }.map { it.split(Regex("\\s+")) }.toList()
        require(rows.size == 7776 && rows.all { it.size == 2 && Regex("[1-6]{5}").matches(it[0]) && Regex("[a-z]+(?:-[a-z]+)*").matches(it[1]) })
        require(rows.map { it[0] }.toSet().size == 7776 && rows.map { it[1] }.toSet().size == 7776)
        return rows.map { it[1] }
    }

    fun phrase(context: Context, count: Int = 6): String = phrase(wordlist(context.assets
        .open("flutter_assets/assets/eff_large_wordlist.txt").bufferedReader().use { it.readText() }), count)

    fun phrase(words: List<String>, count: Int = 6): String {
        require(count == 6 || count == 8)
        require(words.size == 7776 && words.toSet().size == 7776)
        val chosen = List(count) { words[random.nextInt(words.size)] }.toMutableList()
        chosen[0] = chosen[0].replaceFirstChar { it.uppercaseChar() }
        // The strength estimate counts only independent words; the compatibility suffix adds no claimed entropy.
        return chosen.joinToString(".") + "-${random.nextInt(10)}!"
    }
}
