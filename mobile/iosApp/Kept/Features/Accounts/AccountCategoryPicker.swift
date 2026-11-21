import SwiftUI

/// A menu to choose a category from the categories the page provides (nil = uncategorised).
/// `onChange` gets the chosen category id, or nil for "Uncategorised"; the caller saves it.
struct AccountCategoryPicker: View {
    let categories: [AccountPage.Category]
    let selection: String?
    var title = "Category"
    let onChange: (String?) -> Void

    private var binding: Binding<String> {
        Binding(
            get: { selection ?? "" },
            set: { value in
                onChange(value.isEmpty ? nil : value)
            }
        )
    }

    var body: some View {
        let sorted = AccountsLogic.sortedCategories(categories)
        Picker(title, selection: binding) {
            Text("Uncategorised").tag("")
            ForEach(sorted) { category in
                Text(AccountsLogic.categoryLabel(category, categories)).tag(category.id)
            }
        }
        .pickerStyle(.menu)
    }
}
