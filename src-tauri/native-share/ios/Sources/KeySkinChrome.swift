import Tauri
import UIKit
import WebKit

private struct ChromeItem: Decodable, Equatable {
    let id: String
    let title: String
    let label: String
    let icon: String?
    let enabled: Bool
    let selected: Bool
    let primary: Bool
    let busy: Bool
}

private struct ChromeAction: Decodable {
    let item: ChromeItem
    let x: CGFloat
    let y: CGFloat
    let width: CGFloat
    let height: CGFloat
}

private struct ProjectRow: Decodable, Equatable {
    let item: ChromeItem
    let depth: Int
    let heading: Bool
}

private struct ProjectSnapshot: Decodable, Equatable {
    let segment: Int
    let rows: [ProjectRow]
    let tools: [ChromeItem]
    let search: String?
}

private struct ChromeSnapshot: Decodable {
    let tabs: [ChromeItem]
    let showTabs: Bool
    let dark: Bool
    let width: CGFloat
    let height: CGFloat
    let actions: [ChromeAction]
    let icons: [String: String]
    let project: ProjectSnapshot?
}

private struct ChromeArgs: Decodable {
    let snapshot: ChromeSnapshot
    let events: Channel?
}

private struct ChromeEvent: Encodable {
    let kind: String
    let id: String
    var x: CGFloat? = nil
    var y: CGFloat? = nil
}

private class ChromeOverlay: UIView {
    weak var bar: UITabBar?
    weak var project: UIView?
    let actions = UIView()

    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if let project = project, !project.isHidden {
            return project.hitTest(convert(point, to: project), with: event)
        }
        if let bar = bar, !bar.isHidden,
           let hit = bar.hitTest(convert(point, to: bar), with: event) { return hit }
        let hit = actions.hitTest(convert(point, to: actions), with: event)
        return hit === actions ? nil : hit
    }
}

@available(iOS 26.0, *)
private func configureGlass(_ button: UIButton, _ item: ChromeItem, image: UIImage?) {
    var configuration = item.primary ? UIButton.Configuration.prominentGlass() : .glass()
    configuration.cornerStyle = .capsule
    configuration.title = item.title.isEmpty ? nil : item.title
    configuration.image = image
    configuration.imagePadding = item.title.isEmpty ? 0 : 5
    configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 3, bottom: 0, trailing: 3)
    configuration.showsActivityIndicator = item.busy
    button.configuration = configuration
    button.isEnabled = item.enabled && !item.busy
    button.isSelected = item.selected
    button.accessibilityLabel = item.label
    button.accessibilityTraits = item.selected ? [.button, .selected] : .button
    if !button.isEnabled { button.accessibilityTraits.insert(.notEnabled) }
}

@available(iOS 26.0, *)
private final class ChromeController: NSObject, UITabBarControllerDelegate {
    private let overlay = ChromeOverlay()
    private let tabController = UITabBarController()
    private let project = ProjectPanel()
    private var controllers: [String: UIViewController] = [:]
    private var buttons: [String: UIButton] = [:]
    private var icons: [String: UIImage] = [:]
    private var events: Channel?
    private weak var webview: WKWebView?
    private var lastProject: ProjectSnapshot?
    private var scale: CGFloat = 1
    private var origin: CGPoint = .zero

    init(parent: UIViewController, webview: WKWebView) {
        self.webview = webview
        super.init()
        overlay.frame = parent.view.bounds
        overlay.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tabController.traitOverrides.horizontalSizeClass = .compact
        tabController.delegate = self
        parent.addChild(tabController)
        tabController.view.frame = overlay.bounds
        tabController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        tabController.view.backgroundColor = .clear
        overlay.addSubview(tabController.view)
        overlay.bar = tabController.tabBar
        tabController.tabBar.tintColor = .systemPurple
        tabController.didMove(toParent: parent)
        overlay.actions.frame = overlay.bounds
        overlay.actions.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        overlay.addSubview(overlay.actions)
        overlay.project = project
        overlay.addSubview(project)
        project.translatesAutoresizingMaskIntoConstraints = false
        let idealWidth = project.widthAnchor.constraint(equalToConstant: 340)
        idealWidth.priority = .defaultHigh
        let safeBottom = project.bottomAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.bottomAnchor)
        safeBottom.priority = .defaultHigh
        NSLayoutConstraint.activate([
            project.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
            project.topAnchor.constraint(equalTo: overlay.safeAreaLayoutGuide.topAnchor),
            project.bottomAnchor.constraint(lessThanOrEqualTo: overlay.keyboardLayoutGuide.topAnchor),
            safeBottom,
            project.widthAnchor.constraint(lessThanOrEqualTo: overlay.widthAnchor, multiplier: 0.88),
            idealWidth
        ])
        project.isHidden = true
        project.send = { [weak self] event in self?.send(event) }
        parent.view.addSubview(overlay)
    }

    private func send(_ event: ChromeEvent) { try? events?.send(event) }

    func tabBarController(_ tabBarController: UITabBarController, shouldSelect viewController: UIViewController) -> Bool {
        guard let id = controllers.first(where: { $0.value === viewController })?.key,
              viewController.tabBarItem.isEnabled else { return false }
        send(ChromeEvent(kind: "tab", id: id))
        return false
    }

    func apply(_ snapshot: ChromeSnapshot, events: Channel?) {
        if let events { self.events = events }
        overlay.overrideUserInterfaceStyle = snapshot.dark ? .dark : .light
        tabController.overrideUserInterfaceStyle = overlay.overrideUserInterfaceStyle
        for (key, value) in snapshot.icons where icons[key] == nil {
            if let data = Data(base64Encoded: value), let image = UIImage(data: data) {
                let size = key.hasPrefix("tab:") ? CGFloat(23) : CGFloat(16)
                icons[key] = UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { _ in
                    image.draw(in: CGRect(x: 0, y: 0, width: size, height: size))
                }.withRenderingMode(.alwaysTemplate)
            }
        }
        let next = snapshot.tabs.map { item -> UIViewController in
            let controller = controllers[item.id] ?? UIViewController()
            if controllers[item.id] == nil {
                controller.view.backgroundColor = .clear
                controller.tabBarItem = UITabBarItem(title: item.title, image: item.icon.flatMap { icons[$0] }, tag: 0)
                controller.tabBarItem.accessibilityIdentifier = "keyskin-tab-\(item.id)"
                controllers[item.id] = controller
            }
            controller.tabBarItem.isEnabled = item.enabled
            return controller
        }
        let existing = tabController.viewControllers ?? []
        if existing.count != next.count || !zip(existing, next).allSatisfy({ $0.0 === $0.1 }) {
            tabController.setViewControllers(next, animated: false)
        }
        if let index = snapshot.tabs.firstIndex(where: { $0.selected }), tabController.selectedIndex != index {
            tabController.selectedIndex = index
        }
        tabController.tabBar.isHidden = !snapshot.showTabs
        tabController.tabBar.accessibilityIdentifier = "keyskin-native-tab-bar"

        if let projectSnapshot = snapshot.project {
            if lastProject != projectSnapshot {
                project.apply(projectSnapshot, icons: icons)
                lastProject = projectSnapshot
            }
            if project.isHidden {
                project.isHidden = false
                overlay.layoutIfNeeded()
                if !UIAccessibility.isReduceMotionEnabled {
                    project.transform = CGAffineTransform(translationX: -project.bounds.width, y: 0)
                    UIView.animate(withDuration: 0.25) { self.project.transform = .identity }
                }
            }
        } else {
            project.isHidden = true
            lastProject = nil
        }

        guard let webview = webview, snapshot.width > 0, snapshot.height > 0 else { return }
        let viewport = overlay.convert(webview.bounds, from: webview)
        scale = viewport.width / snapshot.width
        guard scale > 0 else { return }
        origin = viewport.origin
        let visible = snapshot.project == nil ? snapshot.actions : []
        let ids = Set(visible.map { $0.item.id })
        for id in Array(buttons.keys) where !ids.contains(id) { buttons.removeValue(forKey: id)?.removeFromSuperview() }
        for action in visible {
            let item = action.item
            let button = buttons[item.id] ?? UIButton(type: .system)
            if buttons[item.id] == nil {
                button.accessibilityIdentifier = "keyskin-native-\(item.id)"
                button.addTarget(self, action: #selector(activate(_:event:)), for: .primaryActionTriggered)
                button.addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pan(_:))))
                buttons[item.id] = button
                overlay.actions.addSubview(button)
            }
            var frame = CGRect(x: origin.x + action.x * scale, y: origin.y + action.y * scale,
                               width: action.width * scale, height: action.height * scale)
            if item.title.isEmpty {
                let diameter = min(frame.width, frame.height)
                frame = CGRect(x: frame.midX - diameter / 2, y: frame.midY - diameter / 2, width: diameter, height: diameter)
            }
            button.frame = frame
            configureGlass(button, item, image: item.icon.flatMap { icons[$0] })
        }
    }

    @objc private func activate(_ sender: UIButton, event: UIEvent?) {
        guard let id = buttons.first(where: { $0.value === sender })?.key else { return }
        let point = event?.allTouches?.first?.location(in: overlay) ?? CGPoint(x: sender.frame.midX, y: sender.frame.midY)
        send(ChromeEvent(kind: "action", id: id, x: (point.x - origin.x) / scale, y: (point.y - origin.y) / scale))
    }

    @objc private func pan(_ gesture: UIPanGestureRecognizer) {
        guard gesture.state == .changed, let view = gesture.view,
              let id = buttons.first(where: { $0.value === view })?.key else { return }
        let delta = gesture.translation(in: overlay)
        gesture.setTranslation(.zero, in: overlay)
        send(ChromeEvent(kind: "pan", id: id, x: delta.x / scale, y: delta.y / scale))
    }
}

@available(iOS 26.0, *)
private final class ProjectPanel: UIVisualEffectView, UISearchBarDelegate {
    var send: ((ChromeEvent) -> Void)?
    private let rows = UIStackView()
    private let tools = UIStackView()
    private let scroll = UIScrollView()
    private let search = UISearchBar()
    private let segments = UISegmentedControl(items: ["概览", "源文件"])
    private let closeButton = UIButton(type: .system)
    private let addButton = UIButton(type: .system)

    init() {
        super.init(effect: UIGlassEffect(style: .regular))
        clipsToBounds = true
        layer.cornerRadius = 24
        layer.cornerCurve = .continuous
        accessibilityViewIsModal = true
        accessibilityIdentifier = "keyskin-native-project"
        contentView.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.68)
        let header = UIStackView()
        header.spacing = 12
        header.alignment = .center
        let title = UILabel()
        title.text = "项目"
        title.font = .preferredFont(forTextStyle: .headline)
        title.textColor = .label
        title.adjustsFontForContentSizeCategory = true
        title.accessibilityTraits = .header
        header.addArrangedSubview(closeButton)
        header.addArrangedSubview(title)
        header.addArrangedSubview(addButton)
        for (button, id) in [(closeButton, "close"), (addButton, "new")] {
            button.widthAnchor.constraint(equalToConstant: 44).isActive = true
            button.heightAnchor.constraint(equalToConstant: 44).isActive = true
            button.addAction(UIAction { [weak self] _ in self?.send?(ChromeEvent(kind: "project", id: id)) }, for: .touchUpInside)
        }
        segments.addTarget(self, action: #selector(changeSegment), for: .valueChanged)
        search.delegate = self
        search.placeholder = "搜索"
        rows.axis = .vertical
        tools.spacing = 4
        tools.distribution = .fillEqually
        let layout = UIStackView(arrangedSubviews: [header, segments, tools, search, scroll])
        layout.axis = .vertical
        layout.spacing = 8
        layout.translatesAutoresizingMaskIntoConstraints = false
        rows.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(layout)
        scroll.addSubview(rows)
        NSLayoutConstraint.activate([
            layout.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
            layout.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -12),
            layout.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 12),
            layout.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -12),
            rows.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            rows.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            rows.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            rows.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            rows.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    @objc private func changeSegment() {
        send?(ChromeEvent(kind: "segment", id: String(segments.selectedSegmentIndex)))
    }

    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        send?(ChromeEvent(kind: "search", id: searchText))
    }

    func apply(_ snapshot: ProjectSnapshot, icons: [String: UIImage]) {
        segments.selectedSegmentIndex = snapshot.segment
        search.isHidden = snapshot.search == nil
        if let text = snapshot.search, search.text != text { search.text = text }
        let close = ChromeItem(id: "close", title: "", label: "关闭项目侧栏", icon: "x", enabled: true, selected: false, primary: false, busy: false)
        let add = ChromeItem(id: "new", title: "", label: "新建皮肤", icon: "plus", enabled: true, selected: false, primary: false, busy: false)
        configureGlass(closeButton, close, image: icons["x"])
        configureGlass(addButton, add, image: icons["plus"])
        tools.isHidden = snapshot.tools.isEmpty
        tools.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for item in snapshot.tools {
            let button = UIButton(type: .system)
            configureGlass(button, item, image: item.icon.flatMap { icons[$0] })
            button.addAction(UIAction { [weak self] _ in self?.send?(ChromeEvent(kind: "project", id: item.id)) }, for: .touchUpInside)
            button.heightAnchor.constraint(equalTo: button.widthAnchor).isActive = true
            tools.addArrangedSubview(button)
        }
        rows.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for row in snapshot.rows {
            let item = row.item
            let button = UIButton(type: .system)
            var configuration = UIButton.Configuration.plain()
            configuration.title = item.title
            configuration.image = item.icon.flatMap { icons[$0] }
            configuration.imagePadding = 7
            configuration.baseForegroundColor = .label
            configuration.contentInsets = .init(top: 5, leading: CGFloat(8 + 12 * row.depth), bottom: 5, trailing: 8)
            if item.selected { configuration.background.backgroundColor = tintColor.withAlphaComponent(0.19) }
            button.configuration = configuration
            button.contentHorizontalAlignment = .leading
            button.isEnabled = item.enabled
            button.accessibilityLabel = item.label
            if row.heading { button.accessibilityTraits.insert(.header) }
            if item.selected { button.accessibilityTraits.insert(.selected) }
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
            button.addAction(UIAction { [weak self] _ in self?.send?(ChromeEvent(kind: "project", id: item.id)) }, for: .touchUpInside)
            rows.addArrangedSubview(button)
        }
    }
}

private final class KeySkinChromePlugin: Plugin {
    private weak var webview: WKWebView?
    private var chrome: AnyObject?

    @objc override func load(webview: WKWebView) { self.webview = webview }

    @objc func syncChrome(_ invoke: Invoke) throws {
        guard #available(iOS 26.0, *) else { invoke.resolve(false); return }
        let args = try invoke.parseArgs(ChromeArgs.self)
        DispatchQueue.main.async {
            guard let parent = self.manager.viewController, let webview = self.webview else {
                invoke.resolve(false)
                return
            }
            let controller = self.chrome as? ChromeController ?? ChromeController(parent: parent, webview: webview)
            self.chrome = controller
            controller.apply(args.snapshot, events: args.events)
            invoke.resolve(true)
        }
    }
}

@_cdecl("init_keyskin_chrome")
func initKeySkinChrome() -> Plugin { KeySkinChromePlugin() }
