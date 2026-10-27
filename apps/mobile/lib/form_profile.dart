class FormProfile {
  FormProfile(Map<String, String> values) : values = Map.unmodifiable(values) {
    validate();
  }
  static const limits = {
    'id': 80,
    'label': 120,
    'givenName': 120,
    'familyName': 120,
    'fullName': 240,
    'email': 320,
    'phone': 80,
    'company': 240,
    'addressLine1': 240,
    'addressLine2': 240,
    'postalCode': 32,
    'city': 120,
    'region': 120,
    'country': 2,
    'updatedAt': 80,
  };
  static const labels = {
    'label': 'Profilname',
    'givenName': 'Vorname',
    'familyName': 'Nachname',
    'fullName': 'Vollständiger Name',
    'email': 'E-Mail',
    'phone': 'Telefon',
    'company': 'Firma',
    'addressLine1': 'Straße und Hausnummer',
    'addressLine2': 'Adresszusatz',
    'postalCode': 'Postleitzahl',
    'city': 'Ort',
    'region': 'Bundesland / Region',
    'country': 'Ländercode (z. B. DE)',
  };
  final Map<String, String> values;
  String get id => values['id']!;
  String get label => values['label']!;
  factory FormProfile.fromMap(Map<Object?, Object?> map) {
    if (map.length != limits.length ||
        map.keys.any((key) => !limits.containsKey(key)) ||
        map.values.any((value) => value is! String)) {
      throw const FormatException('Ungültiges Formularprofil.');
    }
    return FormProfile(Map<String, String>.from(map));
  }
  void validate() {
    if (values.length != limits.length ||
        limits.entries.any(
          (entry) =>
              !values.containsKey(entry.key) ||
              values[entry.key]!.length > entry.value ||
              RegExp(r'[\x00-\x1f\x7f-\x9f]').hasMatch(values[entry.key]!),
        ) ||
        !RegExp(r'^[A-Za-z0-9_-]{1,80}$').hasMatch(id) ||
        label.trim().isEmpty ||
        !RegExp(r'^([A-Z]{2})?$').hasMatch(values['country']!) ||
        DateTime.tryParse(values['updatedAt']!) == null ||
        labels.keys
            .where((key) => key != 'label')
            .every((key) => values[key]!.trim().isEmpty)) {
      throw const FormatException(
        'Profilname und mindestens ein Datenfeld erforderlich. Ländercode: zwei Großbuchstaben.',
      );
    }
  }
}
