import 'vault_entry.dart';

class BackupEntry {
  const BackupEntry({
    required this.id,
    required this.title,
    required this.origin,
    required this.username,
  });

  final String id, title, origin, username;

  factory BackupEntry.fromMap(Map<Object?, Object?> map) {
    String field(String name) {
      final value = map[name];
      if (value is! String) throw const FormatException('Ungültige Vorschau.');
      return value;
    }

    if (map.keys.any(
      (key) => !const {'id', 'title', 'origin', 'username'}.contains(key),
    )) {
      throw const FormatException('Ungültige Vorschau.');
    }
    final entry = BackupEntry(
      id: field('id'),
      title: field('title'),
      origin: field('origin'),
      username: field('username'),
    );
    if (!RegExp(r'^[A-Za-z0-9_-]{1,80}$').hasMatch(entry.id) ||
        entry.title.trim().isEmpty ||
        entry.title.length > 120 ||
        entry.origin.length > 2048 ||
        canonicalOrigin(entry.origin) != entry.origin ||
        entry.username.length > 320) {
      throw const FormatException('Ungültige Vorschau.');
    }
    return entry;
  }
}

class BackupPreview {
  BackupPreview._({
    required this.total,
    required this.newCount,
    required this.existing,
    required this.vaultFingerprint,
    required this.archiveFingerprint,
    required List<BackupEntry> entries,
  }) : entries = List.unmodifiable(entries);

  final int total, newCount, existing;
  final String vaultFingerprint, archiveFingerprint;
  final List<BackupEntry> entries;

  factory BackupPreview.fromMap(Map<Object?, Object?> map) {
    int count(String name) {
      final value = map[name];
      if (value is! int || value < 0 || value > 500) {
        throw const FormatException('Ungültige Vorschau.');
      }
      return value;
    }

    String fingerprint(String name) {
      final value = map[name];
      if (value is! String || !RegExp(r'^[a-f0-9]{64}$').hasMatch(value)) {
        throw const FormatException('Ungültige Vorschau.');
      }
      return value;
    }

    final total = count('total');
    final newCount = count('new');
    final existing = count('existing');
    final values = map['entries'];
    if (newCount + existing != total ||
        values is! List ||
        values.length != total) {
      throw const FormatException('Ungültige Vorschau.');
    }
    final entries = <BackupEntry>[];
    final ids = <String>{};
    for (final value in values) {
      if (value is! Map<Object?, Object?>) {
        throw const FormatException('Ungültige Vorschau.');
      }
      final entry = BackupEntry.fromMap(value);
      if (!ids.add(entry.id)) throw const FormatException('Doppelte ID.');
      entries.add(entry);
    }
    return BackupPreview._(
      total: total,
      newCount: newCount,
      existing: existing,
      vaultFingerprint: fingerprint('vaultFingerprint'),
      archiveFingerprint: fingerprint('archiveFingerprint'),
      entries: entries,
    );
  }
}
