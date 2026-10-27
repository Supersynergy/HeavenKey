import 'dart:math';

import 'package:flutter/services.dart';

final _phraseRandom = Random.secure();
Future<List<String>>? _words;

List<String> parseWordlist(String text) {
  final rows = text
      .split('\n')
      .where((line) => line.trim().isNotEmpty)
      .map((line) => line.trim().split(RegExp(r'\s+')))
      .toList();
  if (rows.length != 7776 ||
      rows.any(
        (row) =>
            row.length != 2 ||
            !RegExp(r'^[1-6]{5}$').hasMatch(row[0]) ||
            !RegExp(r'^[a-z]+(?:-[a-z]+)*$').hasMatch(row[1]),
      ) ||
      rows.map((row) => row[0]).toSet().length != 7776 ||
      rows.map((row) => row[1]).toSet().length != 7776) {
    throw const FormatException('Wortliste konnte nicht geprüft werden.');
  }
  return List.unmodifiable(rows.map((row) => row[1]));
}

Future<String> generatePassphrase([int count = 6]) async {
  if (count != 6 && count != 8) throw ArgumentError.value(count);
  final words = await (_words ??= rootBundle
      .loadString('assets/eff_large_wordlist.txt')
      .then(parseWordlist));
  final chosen = List.generate(
    count,
    (_) => words[_phraseRandom.nextInt(words.length)],
  );
  chosen[0] = chosen[0][0].toUpperCase() + chosen[0].substring(1);
  return '${chosen.join('.')}-${_phraseRandom.nextInt(10)}!';
}
