import SwiftUI

/// Add or edit a category.
struct CategoriesCategoryForm: View {
    let store: PageStore<CategoriesPage>
    let category: CategoriesPage.Category?
    let categories: [CategoriesPage.Category]

    @State private var name: String
    @State private var kind: String
    @State private var parentId: String
    @State private var color: String
    @State private var icon: String

    init(store: PageStore<CategoriesPage>, category: CategoriesPage.Category?, categories: [CategoriesPage.Category]) {
        self.store = store
        self.category = category
        self.categories = categories
        _name = State(initialValue: category?.name ?? "")
        _kind = State(initialValue: category?.kind ?? "expense")
        _parentId = State(initialValue: category?.parentId ?? "")
        _color = State(initialValue: category?.color ?? "")
        _icon = State(initialValue: category?.icon ?? "")
    }

    private var parents: [CategoriesPage.Category] {
        categories.filter { $0.parentId == nil && $0.id != category?.id && $0.kind == kind }
    }

    private var effectiveParent: String {
        parents.contains { $0.id == parentId } ? parentId : ""
    }

    var body: some View {
        FormSheet(
            category == nil ? "Add category" : "Edit category",
            busy: store.busy,
            error: store.formErrors["form"],
            submitDisabled: name.trimmingCharacters(in: .whitespaces).isEmpty
        ) {
            await submit()
        } content: {
            Section {
                TextField("Name", text: $name)
                FieldError(store.formErrors["name"])
                Picker("Type", selection: $kind) {
                    Text("Expense").tag("expense")
                    Text("Income").tag("income")
                }
                .pickerStyle(.segmented)
                FieldError(store.formErrors["kind"])
                Picker("Parent (optional)", selection: parentBinding) {
                    Text("None").tag("")
                    ForEach(parents) { parent in
                        Text(parent.name).tag(parent.id)
                    }
                }
                FieldError(store.formErrors["parentId"])
            }
            Section("Colour") {
                CategoriesColorPicker(color: $color)
                FieldError(store.formErrors["color"])
            }
            Section("Icon") {
                CategoriesIconPicker(icon: $icon)
                FieldError(store.formErrors["icon"])
            }
        }
    }

    private var parentBinding: Binding<String> {
        Binding(
            get: { effectiveParent },
            set: { parentId = $0 }
        )
    }

    private func submit() async -> Bool {
        var form = FormFields()
        form.set("name", name.trimmingCharacters(in: .whitespaces))
        form.set("kind", kind)
        form.set("parentId", effectiveParent)
        form.set("color", color)
        form.set("icon", icon)
        if let category {
            form.set("id", category.id)
        }
        let action = category == nil ? "createCategory" : "updateCategory"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}

struct CategoriesColorPicker: View {
    @Binding var color: String

    private var swatches: [String] {
        var list = CategoriesLogic.palette
        let lower = color.lowercased()
        if !color.isEmpty, !list.contains(lower) { list.append(color) }
        return list
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                Button {
                    color = ""
                } label: {
                    Text("None")
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .frame(height: 28)
                        .overlay(Capsule().stroke(color.isEmpty ? Color.primary : Color.secondary, lineWidth: 1))
                }
                .buttonStyle(.plain)
                ForEach(swatches, id: \.self) { swatch in
                    swatchButton(swatch)
                }
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func swatchButton(_ swatch: String) -> some View {
        let selected = color.lowercased() == swatch.lowercased()
        Button {
            color = swatch
        } label: {
            Circle()
                .fill(Color(hex: swatch) ?? Color.gray)
                .frame(width: 28, height: 28)
                .overlay {
                    if selected {
                        Image(systemName: "checkmark")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                    }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Colour \(swatch)")
    }
}

struct CategoriesIconPicker: View {
    @Binding var icon: String

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                Button {
                    icon = ""
                } label: {
                    Text("Default")
                        .font(.caption)
                        .padding(.horizontal, 10)
                        .frame(height: 32)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(icon.isEmpty ? Color.primary : Color.secondary, lineWidth: 1))
                }
                .buttonStyle(.plain)
                ForEach(CategoriesLogic.icons) { option in
                    iconButton(option)
                }
            }
            .padding(.vertical, 2)
        }
    }

    @ViewBuilder
    private func iconButton(_ option: CategoriesIconOption) -> some View {
        let selected = icon == option.name
        Button {
            icon = option.name
        } label: {
            Image(systemName: option.symbol)
                .frame(width: 32, height: 32)
                .foregroundStyle(selected ? Color.primary : Color.secondary)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.primary : Color.secondary, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Icon \(option.name)")
    }
}

/// Add or edit a categorisation rule.
struct CategoriesRuleForm: View {
    let store: PageStore<CategoriesPage>
    let rule: CategoriesPage.Rule?
    let categories: [CategoriesPage.Category]

    @State private var categoryId: String
    @State private var priority: String
    @State private var counterparty: String
    @State private var descriptionText: String
    @State private var iban: String
    @State private var amountSign: String

    init(store: PageStore<CategoriesPage>, rule: CategoriesPage.Rule?, categories: [CategoriesPage.Category]) {
        self.store = store
        self.rule = rule
        self.categories = categories
        _categoryId = State(initialValue: rule?.categoryId ?? categories.first?.id ?? "")
        _priority = State(initialValue: String(rule?.priority ?? 100))
        _counterparty = State(initialValue: rule?.counterpartyContains ?? "")
        _descriptionText = State(initialValue: rule?.descriptionContains ?? "")
        _iban = State(initialValue: rule?.counterpartyIban ?? "")
        _amountSign = State(initialValue: rule?.amountSign ?? "")
    }

    var body: some View {
        FormSheet(
            rule == nil ? "Add rule" : "Edit rule",
            busy: store.busy,
            error: store.formErrors["form"],
            submitDisabled: categoryId.isEmpty
        ) {
            await submit()
        } content: {
            Section {
                TextField("Counterparty contains", text: $counterparty)
                FieldError(store.formErrors["counterpartyContains"])
                TextField("Description contains", text: $descriptionText)
                FieldError(store.formErrors["descriptionContains"])
                TextField("Counterparty IBAN equals", text: $iban)
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                FieldError(store.formErrors["counterpartyIban"])
                Picker("Direction", selection: $amountSign) {
                    Text("Any").tag("")
                    Text("Money out (expense)").tag("expense")
                    Text("Money in (income)").tag("income")
                }
                FieldError(store.formErrors["amountSign"])
            } header: {
                Text("Conditions")
            } footer: {
                Text("A transaction gets the category when it matches every condition you set. Text matching ignores upper and lower case.")
            }
            Section {
                Picker("Category", selection: $categoryId) {
                    ForEach(categories) { category in
                        Text(CategoriesLogic.label(category, in: categories)).tag(category.id)
                    }
                }
                FieldError(store.formErrors["categoryId"])
                LabeledContent("Priority") {
                    TextField("100", text: $priority)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.trailing)
                }
                FieldError(store.formErrors["priority"])
            } footer: {
                Text("Lower priority numbers run first.")
            }
        }
    }

    private func submit() async -> Bool {
        var form = FormFields()
        form.set("categoryId", categoryId)
        form.set("priority", priority)
        form.set("counterpartyContains", counterparty)
        form.set("descriptionContains", descriptionText)
        form.set("counterpartyIban", iban)
        form.set("amountSign", amountSign)
        if let rule {
            form.set("id", rule.id)
        }
        let action = rule == nil ? "createRule" : "updateRule"
        let result = await store.submit(action, form: form)
        return result != nil
    }
}
