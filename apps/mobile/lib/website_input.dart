import 'vault_entry.dart';

/// Entry-form convenience only. Stored records still require canonicalOrigin.
String originFromWebsiteInput(String input) {
  final value = input.trim();
  if (value.isEmpty ||
      value.length > 2048 ||
      value.contains('\\') ||
      RegExp(r'\s').hasMatch(value)) {
    throw const FormatException('Eine HTTPS-Domain eingeben.');
  }
  final source = value.contains('://') ? value : 'https://$value';
  final authority = RegExp(r'^[^:]+://([^/?#]*)').firstMatch(source)?.group(1);
  if (authority == null || authority.contains('%')) {
    throw const FormatException('Eine unkodierte HTTPS-Domain eingeben.');
  }
  final uri = Uri.tryParse(source);
  if (uri == null || uri.scheme != 'https' || uri.userInfo.isNotEmpty) {
    throw const FormatException(
      'Eine HTTPS-Domain ohne Zugangsdaten eingeben.',
    );
  }
  return canonicalOrigin('https://${uri.authority}');
}
