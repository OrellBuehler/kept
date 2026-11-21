import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import VisionKit

/// A file ready to be sent: always a PDF, because that is all the server accepts.
struct BillPickedDocument: Sendable {
    let name: String
    let data: Data
}

struct BillDocumentError: Error, LocalizedError, Sendable {
    let message: String
    var errorDescription: String? { message }
}

enum BillDocumentFile {
    /// The server's limit (`MAX_DOCUMENT_BYTES`): 20 MB.
    nonisolated static let maxBytes = 20 * 1024 * 1024

    nonisolated static func isPDF(_ data: Data) -> Bool {
        data.starts(with: Array("%PDF".utf8))
    }

    /// "scan.jpg" becomes "scan.pdf".
    nonisolated static func pdfName(_ name: String) -> String {
        let base = (name as NSString).deletingPathExtension
        return (base.isEmpty ? "bill" : base) + ".pdf"
    }

    nonisolated static func tooLarge() -> BillDocumentError {
        BillDocumentError(message: "The file is larger than 20 MB.")
    }

    /// A PDF goes as it is; a photo is wrapped into a PDF. Anything else, or anything over the limit, is refused.
    @MainActor
    static func prepare(data: Data, name: String) throws -> BillPickedDocument {
        if data.count > maxBytes { throw tooLarge() }
        if data.isEmpty { throw BillDocumentError(message: "The file is empty.") }
        if isPDF(data) { return BillPickedDocument(name: name, data: data) }
        guard let image = UIImage(data: data) else {
            throw BillDocumentError(message: "Choose a PDF file or an image.")
        }
        let pdf = BillDocumentPDF.make(from: [image])
        if pdf.count > maxBytes { throw tooLarge() }
        return BillPickedDocument(name: pdfName(name), data: pdf)
    }
}

enum BillDocumentPDF {
    /// The longest side of a page in points; larger photos are scaled down to keep the PDF small.
    nonisolated static let maxSide: CGFloat = 2000

    /// The size of the page for an image of this size: its own size, at most `maxSide` on the long side.
    nonisolated static func pageSize(width: CGFloat, height: CGFloat) -> CGSize {
        guard width > 0, height > 0 else { return CGSize(width: 595, height: 842) }
        let scale = min(1, maxSide / max(width, height))
        return CGSize(width: max(1, (width * scale).rounded()), height: max(1, (height * scale).rounded()))
    }

    /// The image redrawn at page size and stored as JPEG, so a large photo or a PNG does not bloat the PDF.
    @MainActor
    private static func compressed(_ image: UIImage, size: CGSize) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let jpeg = rendered.jpegData(compressionQuality: 0.7), let decoded = UIImage(data: jpeg) else {
            return rendered
        }
        return decoded
    }

    /// One page per image, each as large as its image (scaled down), as a PDF.
    @MainActor
    static func make(from images: [UIImage]) -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 595, height: 842))
        var pages: [UIImage] = []
        for image in images {
            let size = pageSize(width: image.size.width, height: image.size.height)
            pages.append(compressed(image, size: size))
        }
        let finished = pages
        return renderer.pdfData { context in
            for page in finished {
                let bounds = CGRect(origin: .zero, size: page.size)
                context.beginPage(withBounds: bounds, pageInfo: [:])
                page.draw(in: bounds)
            }
        }
    }
}

/// Adds the three ways to get a document (file, photo library, camera scan) to a screen. The
/// screen only flips the three flags from its buttons and receives the result.
struct BillDocumentSources: ViewModifier {
    @Binding var showFiles: Bool
    @Binding var showPhotos: Bool
    @Binding var showScanner: Bool
    let onPicked: (BillPickedDocument) -> Void
    let onFailed: (String) -> Void

    @State private var photoItem: PhotosPickerItem?

    func body(content: Content) -> some View {
        content
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.pdf, .image]) { result in
                handleFile(result)
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItem, matching: .images)
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                photoItem = nil
                Task { await loadPhoto(item) }
            }
            .fullScreenCover(isPresented: $showScanner) {
                BillScannerView(
                    onFinish: { data in
                        showScanner = false
                        if data.count > BillDocumentFile.maxBytes {
                            onFailed("The scan is larger than 20 MB.")
                        } else {
                            onPicked(BillPickedDocument(name: "scan.pdf", data: data))
                        }
                    },
                    onCancel: { showScanner = false }
                )
                .ignoresSafeArea()
            }
    }

    @MainActor
    private func handleFile(_ result: Result<URL, Error>) {
        switch result {
        case let .failure(error):
            onFailed(error.localizedDescription)
        case let .success(url):
            let started = url.startAccessingSecurityScopedResource()
            defer { if started { url.stopAccessingSecurityScopedResource() } }
            do {
                let data = try Data(contentsOf: url)
                onPicked(try BillDocumentFile.prepare(data: data, name: url.lastPathComponent))
            } catch let error as BillDocumentError {
                onFailed(error.message)
            } catch {
                onFailed("The file could not be read.")
            }
        }
    }

    @MainActor
    private func loadPhoto(_ item: PhotosPickerItem) async {
        let data: Data?
        do {
            data = try await item.loadTransferable(type: Data.self)
        } catch {
            onFailed("The photo could not be loaded.")
            return
        }
        guard let data else {
            onFailed("The photo could not be loaded.")
            return
        }
        do {
            onPicked(try BillDocumentFile.prepare(data: data, name: "photo.jpg"))
        } catch let error as BillDocumentError {
            onFailed(error.message)
        } catch {
            onFailed("The photo could not be used.")
        }
    }
}

extension View {
    func billDocumentSources(
        showFiles: Binding<Bool>,
        showPhotos: Binding<Bool>,
        showScanner: Binding<Bool>,
        onPicked: @escaping (BillPickedDocument) -> Void,
        onFailed: @escaping (String) -> Void
    ) -> some View {
        modifier(
            BillDocumentSources(
                showFiles: showFiles,
                showPhotos: showPhotos,
                showScanner: showScanner,
                onPicked: onPicked,
                onFailed: onFailed
            )
        )
    }
}

/// The three buttons that start the sources above; put them in a `Section`.
struct BillDocumentButtons: View {
    @Binding var showFiles: Bool
    @Binding var showPhotos: Bool
    @Binding var showScanner: Bool
    var disabled = false

    var body: some View {
        Button {
            showFiles = true
        } label: {
            Label("Choose a PDF or image", systemImage: "folder")
        }
        .disabled(disabled)
        Button {
            showPhotos = true
        } label: {
            Label("Choose a photo", systemImage: "photo")
        }
        .disabled(disabled)
        if VNDocumentCameraViewController.isSupported {
            Button {
                showScanner = true
            } label: {
                Label("Scan with the camera", systemImage: "camera")
            }
            .disabled(disabled)
        }
    }
}

/// The system document scanner. It hands back the scanned pages as one PDF.
struct BillScannerView: UIViewControllerRepresentable {
    let onFinish: (Data) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onFinish: onFinish, onCancel: onCancel)
    }

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let controller = VNDocumentCameraViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}

    final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onFinish: (Data) -> Void
        let onCancel: () -> Void

        init(onFinish: @escaping (Data) -> Void, onCancel: @escaping () -> Void) {
            self.onFinish = onFinish
            self.onCancel = onCancel
        }

        nonisolated func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFinishWith scan: VNDocumentCameraScan
        ) {
            var pages: [UIImage] = []
            for index in 0 ..< scan.pageCount {
                pages.append(scan.imageOfPage(at: index))
            }
            let images = pages
            MainActor.assumeIsolated {
                let pdf = BillDocumentPDF.make(from: images)
                self.onFinish(pdf)
            }
        }

        nonisolated func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            MainActor.assumeIsolated {
                self.onCancel()
            }
        }

        nonisolated func documentCameraViewController(
            _ controller: VNDocumentCameraViewController,
            didFailWithError error: Error
        ) {
            MainActor.assumeIsolated {
                self.onCancel()
            }
        }
    }
}
