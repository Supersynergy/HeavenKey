import XCTest
@testable import Runner

final class RunnerTests: XCTestCase {
    func testWebsiteBoundaries() throws {
        XCTAssertEqual(try VaultPolicy.origin("https://EXAMPLE.com:443/"), "https://example.com")
        XCTAssertEqual(try VaultPolicy.serviceOrigin("https://example.com/login?next=https://other.example", isDomain: false), "https://example.com")
        XCTAssertNotEqual(try VaultPolicy.origin("https://example.com"), try VaultPolicy.origin("https://example.com:8443"))
        for invalid in ["http://example.com", "https://u:p@example.com", "https://example.com.", "https://ex%61mple.com", "https://localhost"] {
            XCTAssertThrowsError(try VaultPolicy.origin(invalid))
        }
    }
}
