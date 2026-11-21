import SwiftUI

/// Everything that has no tab of its own.
struct MoreView: View {
    var body: some View {
        List {
            Section {
                link("Forecast", "chart.line.uptrend.xyaxis", .forecast)
                link("Recurring", "repeat", .recurring)
                link("Year in review", "calendar", .review)
                link("Reports", "doc.richtext", .reports)
            }
            Section {
                link("Investments", "chart.xyaxis.line", .investments)
                link("Pillar 3a", "lock.shield", .pillar3a)
                link("Taxes", "scalemass", .taxes)
            }
            Section {
                link("Import", "square.and.arrow.up", .importFiles)
                link("Settings", "gearshape", .settings)
            }
        }
        .navigationTitle("More")
    }

    private func link(_ title: String, _ systemImage: String, _ route: Route) -> some View {
        NavigationLink(value: route) {
            ValueRow(title, systemImage: systemImage)
        }
    }
}
