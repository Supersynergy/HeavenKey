import 'dart:math';

String canonicalOrigin(String value) {
  final uri = Uri.tryParse(value);
  if (value != value.trim() ||
      RegExp(r'\s').hasMatch(value) ||
      uri == null ||
      uri.scheme != 'https' ||
      uri.userInfo.isNotEmpty ||
      value.contains('%') ||
      uri.hasQuery ||
      uri.hasFragment ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    throw const FormatException('Eine HTTPS-Website ohne Pfad eingeben.');
  }
  final host = uri.host.toLowerCase();
  final labels = host.split('.');
  final label = RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');
  if (host.length > 253 ||
      labels.length < 2 ||
      labels.any((value) => !label.hasMatch(value)) ||
      RegExp(r'^[0-9.]+$').hasMatch(host) ||
      uri.port < 1 ||
      uri.port > 65535) {
    throw const FormatException('Eine gültige HTTPS-Domain eingeben.');
  }
  return 'https://$host${uri.port == 443 ? '' : ':${uri.port}'}';
}

final _random = Random.secure();
String newEntryId() => List.generate(
  16,
  (_) => _random.nextInt(256).toRadixString(16).padLeft(2, '0'),
).join();

String generatePassword([int length = 24]) {
  if (length < 16 || length > 128) throw RangeError.range(length, 16, 128);
  const groups = [
    'ABCDEFGHJKLMNPQRSTUVWXYZ',
    'abcdefghijkmnopqrstuvwxyz',
    '23456789',
    '!@#%+-_=?:',
  ];
  final alphabet = groups.join();
  final chars = [
    for (final group in groups) group[_random.nextInt(group.length)],
  ];
  while (chars.length < length) {
    chars.add(alphabet[_random.nextInt(alphabet.length)]);
  }
  for (var i = chars.length - 1; i > 0; i--) {
    final j = _random.nextInt(i + 1);
    final previous = chars[i];
    chars[i] = chars[j];
    chars[j] = previous;
  }
  return chars.join();
}

class VaultEntry {
  const VaultEntry({
    required this.id,
    required this.title,
    required this.origin,
    required this.username,
    required this.password,
    this.notes = '',
    required this.updatedAt,
  });
  final String id, title, origin, username, password, notes, updatedAt;

  factory VaultEntry.fromMap(Map<Object?, Object?> map) {
    String field(String name) {
      final value = map[name];
      if (value is! String) throw const FormatException('Ungültiger Eintrag.');
      return value;
    }

    return VaultEntry(
      id: field('id'),
      title: field('title'),
      origin: field('origin'),
      username: field('username'),
      password: field('password'),
      notes: field('notes'),
      updatedAt: field('updatedAt'),
    )..validate();
  }

  void validate() {
    if (!RegExp(r'^[A-Za-z0-9_-]{1,80}$').hasMatch(id) ||
        title.trim().isEmpty ||
        title.length > 120 ||
        origin.length > 2048 ||
        canonicalOrigin(origin) != origin ||
        username.length > 320 ||
        password.isEmpty ||
        password.length > 1024 ||
        notes.length > 4096 ||
        DateTime.tryParse(updatedAt) == null) {
      throw const FormatException('Ungültiger oder zu langer Eintrag.');
    }
  }

  Map<String, String> toMap() => {
    'id': id,
    'title': title,
    'origin': origin,
    'username': username,
    'password': password,
    'notes': notes,
    'updatedAt': updatedAt,
  };
  bool matches(String search) => [
    title,
    origin,
    username,
  ].any((value) => value.toLowerCase().contains(search.toLowerCase()));
}

({int short, int reused}) passwordHealth(List<VaultEntry> entries) {
  final counts = <String, int>{};
  for (final entry in entries) {
    counts.update(entry.password, (value) => value + 1, ifAbsent: () => 1);
  }
  return (
    short: entries.where((entry) => entry.password.length < 16).length,
    reused: entries.where((entry) => counts[entry.password]! > 1).length,
  );
}
