import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:heavenkey_mobile/main.dart';
import 'package:heavenkey_mobile/wallet_panel.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const vault = MethodChannel('heavenkey/vault');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  final approvals = <Map<Object?, Object?>>[];
  Map<Object?, Object?>? outcome;
  List<Map<String, String>> activity = [];
  final checkedReceipts = <String>[];
  late Map<Object?, Object?> preview;
  var available = true;
  var pending = true;
  var ayaEnabled = false;
  var membershipStatus = 'valid';
  late Map<Object?, Object?> approvalResult;
  Completer<Map<Object?, Object?>>? delayedApproval;

  setUp(() {
    approvals.clear();
    checkedReceipts.clear();
    activity = [];
    available = true;
    pending = true;
    outcome = null;
    approvalResult = {'status': 'verified'};
    ayaEnabled = false;
    membershipStatus = 'valid';
    delayedApproval = null;
    preview = {
      'id': 'request-unique',
      'fingerprint': 'frozen-version',
      'kind': 'invoice.draft.create',
      'recipient': 'Supersynergy Test',
      'target': 'https://issuer.example.test/direct-post',
      'expires_at': 2000000000,
      'claims': {'org_id': 'supersynergy-demo', 'membership': 'project-member'},
      'operation': {
        'kind': 'invoice.draft.create',
        'tenant': 'test-tenant',
        'resource': 'order-demo',
        'agent_id': 'invoice-agent',
        'amount_minor': 2599,
        'currency': 'EUR',
        'uses': 1,
        'expiration': 2000000000,
      },
    };
    messenger.setMockMethodCallHandler(vault, (call) async {
      return switch (call.method) {
        'status' => {
          'platform': 'android',
          'available': true,
          'secureDevice': true,
          'hasVault': true,
        },
        'unlock' => <Object?>[],
        _ => null,
      };
    });
    messenger.setMockMethodCallHandler(walletChannel, (call) async {
      switch (call.method) {
        case 'status':
          return {
            'available': available,
            'pending': pending,
            'aya_enabled': ayaEnabled,
          };
        case 'list':
          return [
            {
              'id': 'synthetic-local-id',
              'issuer': 'Supersynergy Test',
              'org_id': 'supersynergy-demo',
              'membership': 'project-member',
              'expires_at': 2000000000,
              'status': membershipStatus,
            },
          ];
        case 'activity':
          return activity;
        case 'getRequestStatus':
          final arguments = call.arguments as Map?;
          if (arguments?['id'] case final String id) {
            checkedReceipts.add(id);
            activity = [
              for (final receipt in activity)
                if (receipt['id'] == id)
                  {
                    ...receipt,
                    'status': 'verified',
                    'action_status': 'executed',
                  }
                else
                  receipt,
            ];
          }
          return outcome;
        case 'prepare':
          return preview;
        case 'approve':
          approvals.add(Map<Object?, Object?>.from(call.arguments as Map));
          pending = false;
          if (delayedApproval case final result?) outcome = await result.future;
          return outcome ??= approvalResult;
        case 'cancel':
          pending = false;
          return null;
        case 'setAya':
          ayaEnabled = (call.arguments as Map)['enabled'] == true;
          return null;
        default:
          throw MissingPluginException(call.method);
      }
    });
  });

  tearDown(() {
    messenger.setMockMethodCallHandler(vault, null);
    messenger.setMockMethodCallHandler(walletChannel, null);
  });

  Future<void> tap(WidgetTester tester, String label) async {
    await tester.ensureVisible(find.text(label));
    await tester.tap(find.text(label));
    await tester.pumpAndSettle();
  }

  Future<void> unlock(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(800, 1400);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);
    await tester.pumpWidget(const HeavenKeyApp());
    await tester.pumpAndSettle();
    await tap(tester, 'Tresor entsperren');
  }

  testWidgets('no wallet entry in builds without the test profile', (
    tester,
  ) async {
    available = false;
    await unlock(tester);
    expect(find.text('Nachweise'), findsNothing);
    expect(find.text('Anfrage'), findsNothing);
    expect(find.text('Tresor'), findsOneWidget);
  });

  testWidgets('a native browser handoff reveals an unopened request', (
    tester,
  ) async {
    pending = false;
    await unlock(tester);
    expect(find.text('Nachweise'), findsOneWidget);
    pending = true;
    await messenger.handlePlatformMessage(
      walletChannel.name,
      walletChannel.codec.encodeMethodCall(const MethodCall('changed')),
      null,
    );
    await tester.pumpAndSettle();
    expect(find.text('Anfrage'), findsOneWidget);
    expect(find.textContaining('Geprüfter Empfänger'), findsNothing);
    expect(approvals, isEmpty);
  });

  testWidgets('stores a test membership only after showing its issuer', (
    tester,
  ) async {
    preview = {
      ...preview,
      'kind': 'issuance',
      'target': 'https://issuer.example.test/credential',
      'claims': <String, String>{},
      'operation': <String, String>{},
    };
    approvalResult = {'kind': 'issuance', 'status': 'issued'};
    await unlock(tester);
    await tap(tester, 'Anfrage');
    await tap(tester, 'Offene Anfrage prüfen');
    expect(find.text('Testaussteller: Supersynergy Test'), findsWidgets);
    expect(
      find.text('Nachweistyp: Organisationsmitgliedschaft'),
      findsOneWidget,
    );
    expect(find.textContaining('Mandant:'), findsNothing);
    expect(approvals, isEmpty);
    await tap(tester, 'Nachweis speichern');
    expect(approvals, hasLength(1));
    expect(find.textContaining('auf diesem Gerät gespeichert'), findsOneWidget);
  });

  testWidgets('shows only the approved project and sends its fingerprint', (
    tester,
  ) async {
    preview = {
      ...preview,
      'kind': 'project.access',
      'operation': {'tenant': 'test-tenant', 'resource': 'project-demo'},
    };
    await unlock(tester);
    await tap(tester, 'Anfrage');
    await tap(tester, 'Offene Anfrage prüfen');
    expect(find.text('Projekt: project-demo'), findsOneWidget);
    expect(find.text('Vorgang unique'), findsOneWidget);
    expect(find.text('Organisation: supersynergy-demo'), findsOneWidget);
    expect(find.textContaining('Agent:'), findsNothing);
    await tap(tester, 'Angaben übermitteln');
    expect(approvals.single, {
      'id': 'request-unique',
      'fingerprint': 'frozen-version',
    });
    expect(
      find.textContaining('ursprünglichen Browsersitzung'),
      findsOneWidget,
    );
  });

  testWidgets('shows the exact invoice draft grant and its real outcome', (
    tester,
  ) async {
    approvalResult = {'status': 'verified', 'action_status': 'approved'};
    await unlock(tester);
    await tap(tester, 'Anfrage');
    expect(find.text('Gültig laut letzter Prüfung'), findsOneWidget);
    await tap(tester, 'Offene Anfrage prüfen');
    expect(find.text('Geprüfter Empfänger: Supersynergy Test'), findsOneWidget);
    expect(find.text('Organisation: supersynergy-demo'), findsOneWidget);
    expect(find.text('Mandant: test-tenant'), findsOneWidget);
    expect(find.text('Auftrag: order-demo'), findsOneWidget);
    expect(find.text('Agent: invoice-agent'), findsOneWidget);
    expect(find.text('Entwurfsbetrag: 25,99 EUR'), findsOneWidget);
    expect(find.textContaining('Einmal verwendbar bis'), findsOneWidget);
    expect(approvals, isEmpty);
    await tap(tester, 'Auftrag freigeben');
    expect(approvals, [
      {'id': 'request-unique', 'fingerprint': 'frozen-version'},
    ]);
    expect(find.textContaining('Auftrag einmalig freigegeben'), findsOneWidget);
    expect(find.textContaining('Rechnungsentwurf erstellt'), findsNothing);
    outcome = {
      'kind': 'invoice.draft.create',
      'status': 'verified',
      'action_status': 'executed',
    };
    membershipStatus = 'revoked';
    await tap(tester, 'Vorgangsstatus prüfen');
    expect(find.textContaining('Rechnungsentwurf erstellt'), findsOneWidget);
    expect(find.text('Widerrufen'), findsOneWidget);
  });

  testWidgets('blocks confirmation when the preview contains a hidden field', (
    tester,
  ) async {
    (preview['operation'] as Map)['more'] = 'sensitive_data';
    await unlock(tester);
    await tap(tester, 'Anfrage');
    await tap(tester, 'Offene Anfrage prüfen');
    expect(find.text('Auftrag freigeben'), findsNothing);
    expect(find.textContaining('sensitive_data'), findsNothing);
    expect(find.textContaining('nicht vollständig angezeigt'), findsOneWidget);
    expect(approvals, isEmpty);
  });

  testWidgets('lock hides a preview and a delayed result cannot reopen it', (
    tester,
  ) async {
    delayedApproval = Completer<Map<Object?, Object?>>();
    await unlock(tester);
    await tap(tester, 'Anfrage');
    await tap(tester, 'Offene Anfrage prüfen');
    await tester.tap(find.text('Auftrag freigeben'));
    await tester.pump();

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    expect(find.text('Geprüfter Empfänger: Supersynergy Test'), findsNothing);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    await tester.pump();
    delayedApproval!.complete({
      'kind': 'invoice.draft.create',
      'status': 'verified',
    });
    await tester.pump();
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.hidden);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();

    expect(find.text('Tresor entsperren'), findsOneWidget);
    expect(
      find.textContaining('Empfänger hat den Nachweis geprüft'),
      findsNothing,
    );
    expect(approvals, hasLength(1));
  });

  testWidgets('covers an approval while system authentication has focus', (
    tester,
  ) async {
    delayedApproval = Completer<Map<Object?, Object?>>();
    await unlock(tester);
    await tap(tester, 'Anfrage');
    await tap(tester, 'Offene Anfrage prüfen');
    await tester.tap(find.text('Auftrag freigeben'));
    await tester.pump();

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
    await tester.pump();
    delayedApproval!.complete({'status': 'outcome_unknown'});
    await tester.pumpAndSettle();
    expect(find.textContaining('Ausgang unklar'), findsNothing);

    tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
    await tester.pumpAndSettle();
    expect(find.textContaining('Ausgang unklar'), findsOneWidget);
    expect(approvals, hasLength(1));
  });

  testWidgets('reconciles the exact earlier receipt after a newer operation', (
    tester,
  ) async {
    pending = false;
    outcome = {'id': 'current', 'kind': 'issuance', 'status': 'issued'};
    activity = [
      {'id': 'current', 'kind': 'issuance', 'status': 'issued'},
      {
        'id': 'earlier-device-id',
        'kind': 'invoice.draft.create',
        'status': 'outcome_unknown',
      },
    ];
    await unlock(tester);
    await tap(tester, 'Nachweise');
    await tap(tester, 'Frühere Vorgänge');
    expect(find.textContaining('Ausgang unklar'), findsOneWidget);
    await tester.tap(find.byTooltip('Status dieses Vorgangs prüfen'));
    await tester.pumpAndSettle();
    expect(checkedReceipts, ['earlier-device-id']);
    expect(
      find.text('Zielanwendung hat den Rechnungsentwurf erstellt.'),
      findsOneWidget,
    );
  });

  testWidgets('can cancel a pending request and toggle presentation of AYA', (
    tester,
  ) async {
    await unlock(tester);
    await tap(tester, 'Anfrage');
    await tap(tester, 'Offene Anfrage prüfen');
    await tap(tester, 'Abbrechen');
    expect(find.text('Anfrage abgebrochen.'), findsOneWidget);
    expect(approvals, isEmpty);
    await tap(tester, 'AYA-Profil anzeigen');
    expect(ayaEnabled, isTrue);
    expect(find.textContaining('AYA ID und CONNECT'), findsOneWidget);
  });
}
