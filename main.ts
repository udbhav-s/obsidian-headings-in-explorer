import {
	App,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	WorkspaceLeaf,
} from "obsidian";
import { FileTreeItem, FileExplorerView } from "obsidian-typings";

interface HeadingPluginSettings {
	showHeadingsForAllFolders: boolean;
	showHeadingFolders: string[];

	showHeadings: boolean;
	showHeading1: boolean;
	showHeading2: boolean;
	showHeading3: boolean;
	showHeading4: boolean;
	showHeading5: boolean;
	showHeading6: boolean;
	regexArray: RegexSetting[];
}

const DEFAULT_SETTINGS: HeadingPluginSettings = {
	showHeadingsForAllFolders: true,
	showHeadingFolders: [],
	showHeadings: true,
	showHeading1: true,
	showHeading2: true,
	showHeading3: true,
	showHeading4: true,
	showHeading5: true,
	showHeading6: true,
	regexArray: [
		{
			pattern: "^\\*\\*([^*]+)\\*\\*$",
			level: 7,
		},
	],
};

const USER_SETTINGS = structuredClone(
	DEFAULT_SETTINGS
) as HeadingPluginSettings;

interface RegexSetting {
	pattern: string;
	level: number;
}

interface HeadingEntry {
	text: string;
	level: number;
	line: number;
	uiElement?: HTMLElement;
}

interface HeadingEntryCache {
	[key: string]: HeadingEntry[];
}

export default class HeadingPlugin extends Plugin {
	settings: HeadingPluginSettings = USER_SETTINGS;
	lastActiveMarkdownLeaf: WorkspaceLeaf | null = null;
	cachedHeadings: HeadingEntryCache = {};

	async onload() {
		await this.loadSettings();

		this.addSettingTab(new HeadingSettingTab(this.app, this));

		// I think I've fixed the errors that could arise here, but prepare to fail gracefully anyway
		let retries = 0;
		const timedRetry = () => {
			try {
				// get first active leaf
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					this.lastActiveMarkdownLeaf = markdownView.leaf;
				}

				this.init();
			} catch (e) {
				if (retries > 5) {
					new Notice(
						"Failed to initialize headings plugin." + e.message
					);
					return;
				}

				retries++;
				setTimeout(timedRetry, 1000);
			}
		};

		this.app.workspace.onLayoutReady(timedRetry);

		const onFileModified = async (file: TFile) => {
			if (!this.settings.showHeadings) {
				return;
			}

			if (!file.parent || !this.settings.showHeadingFolders.contains(file.parent.path)) {
				return;
			}

			if (file instanceof TFile && file.extension === "md") {
				// wait for the metadata cache to update
				setTimeout(async () => {
					const headingsForFile = (await this.createHeadingsForFile(
						file
					)) as HeadingEntry[];
					this.cachedHeadings[file.path] = headingsForFile;
					this.clearExplorerHeight();
				}, 500);
			}
		};

		this.registerEvent(this.app.vault.on("modify", onFileModified));
		this.registerEvent(this.app.vault.on("rename", onFileModified));

		// track my last active markdown leaf
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", (leaf) => {
				if (leaf && leaf.view.getViewType() === "markdown") {
					this.lastActiveMarkdownLeaf = leaf;
				}
			})
		);

		this.addCommand({
			id: "toggle-headings",
			name: "Toggle File Explorer Headings",
			callback: async () => {
				this.settings.showHeadings = !this.settings.showHeadings;
				await this.saveSettings();
				await this.recalculateHeadings();
			},
		});

		this.app.workspace.onLayoutReady(async () => {
			const items = await this.getFileExplorerFileItems();
			const fileItem = items[Object.keys(items)[0]];
			await this.applyTitleUpdatePatch(fileItem as FileTreeItem);

			this.registerFolderHeadingContextMenu();
		});
	}

	// binary search sorted array to find closest line on or above target
	findClosestLineOnOrAbove(
		headingArray: HeadingEntry[],
		target: number
	): HeadingEntry | null {
		if (headingArray.length === 0) return null;

		let start = 0;
		let end = headingArray.length - 1;
		let bestMatch: HeadingEntry | null = null;

		while (start <= end) {
			const mid = Math.floor((start + end) / 2);
			const currentLine = headingArray[mid].line;

			if (currentLine === target) {
				return headingArray[mid];
			} else if (currentLine < target) {
				bestMatch = headingArray[mid];
				start = mid + 1;
			} else {
				end = mid - 1;
			}
		}

		return bestMatch;
	}

	/**
	 * Patch FileTreeItem's updateTitle to add headings whenever a new file item is rendered
	 *
	 * @param fileItem A file item used to get the FileTreeItem prototype
	 * @returns
	 */
	async applyTitleUpdatePatch(fileItem: FileTreeItem) {
		const proto = Object.getPrototypeOf(fileItem);

		if (proto._obsidianHeadingPlugin_patched) return;

		const leaf = await this.getFileExplorerLeaf();
		const scroller = (leaf.view as FileExplorerView).tree.infinityScroll;
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;

		const patched = {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			apply(target: any, ctx: FileTreeItem, args: any) {
				// console.log(
				// 	"Patched updateTitle invoked for file: " + ctx.file.path
				// );
				Reflect.apply(target, ctx, args);

				// Add headings
				if (
					self.settings.showHeadingsForAllFolders ||
					(ctx.file.parent &&
						self.settings.showHeadingFolders.contains(
							ctx.file.parent.path
						))
				) {
					self.createHeadingsForFile(ctx.file);
					scroller.invalidate(ctx, false);
				}
			},
		};

		const proxyFn = new Proxy(proto.updateTitle, patched);
		proto.updateTitle = proxyFn;

		proto._obsidianHeadingPlugin_patched = true;
	}

	async init() {
		this.setupLocateButton();

		if (!this.settings.showHeadings) {
			this.clearExplorerHeight();
			return;
		}

		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			if (
				this.settings.showHeadingsForAllFolders ||
				(file.parent &&
					this.settings.showHeadingFolders.contains(file.parent.path))
			) {
				const headingsForFile = (await this.createHeadingsForFile(
					file
				)) as HeadingEntry[];
				this.cachedHeadings[file.path] = headingsForFile;
			}
		}

		// zeroes out the heights of the file explorer items, or scrolling will break
		this.clearExplorerHeight();
	}

	async setupLocateButton() {
		const fileExplorer = await this.getFileExplorerLeaf();
		const headerDom = fileExplorer.view.headerDom;
		headerDom.navButtonsEl
			.querySelector(".highlight-file-button")
			?.remove();

		if (fileExplorer) {
			const navButton = headerDom.addNavButton(
				"crosshair",
				"Highlight location",
				() => this.highlightFileWithHeading(fileExplorer)
			);
			navButton.addClass("highlight-file-button");
		}
	}

	async highlightFileWithHeading(fileExplorer: WorkspaceLeaf) {
		const activeLeaf = this.lastActiveMarkdownLeaf;

		if (!activeLeaf) {
			return;
		}

		const activeLeafView = activeLeaf.view as MarkdownView;
		const activeFile = activeLeafView.file;

		if (!activeFile) {
			return;
		}
		const activeHeadings = this.cachedHeadings[activeFile.path];

		fileExplorer.view.revealInFolder(activeFile);

		const cursor = activeLeafView.editor.getCursor();
		const line = cursor.line;

		const closestLine = this.findClosestLineOnOrAbove(activeHeadings, line);
		if (closestLine) {
			closestLine.uiElement?.addClass("highlighted-heading");

			setTimeout(() => {
				closestLine.uiElement?.removeClass("highlighted-heading");
			}, 2000);
		}
	}

	async createHeadingsForFile(file: TFile) {
		const fileCache = this.app.metadataCache.getFileCache(file);
		if (!fileCache) {
			return;
		}

		const headings = fileCache.headings || [];
		const mappedHeadings = headings.reduce<HeadingEntry[]>(
			(acc, heading) => {
				if (
					(heading.level === 1 && !this.settings.showHeading1) ||
					(heading.level === 2 && !this.settings.showHeading2) ||
					(heading.level === 3 && !this.settings.showHeading3) ||
					(heading.level === 4 && !this.settings.showHeading4) ||
					(heading.level === 5 && !this.settings.showHeading5) ||
					(heading.level === 6 && !this.settings.showHeading6)
				) {
					return acc;
				}

				const line = heading.position.start.line;
				const headingText = heading.heading;
				const level = heading.level;

				acc.push({
					text: headingText,
					level: level,
					line: line,
				});

				return acc;
			},
			[]
		);

		// short circuit, don't read files if no matching needed
		if (this.settings.regexArray.length === 0) {
			mappedHeadings.sort((a, b) => a.line - b.line);
			await this.createClickableHeadings(file, mappedHeadings);
			return mappedHeadings;
		}

		const fileContent = await this.app.vault.read(file);
		const fileLines = fileContent.split("\n");

		const matchedHeadings: HeadingEntry[] = [];
		fileLines.forEach((line, index) => {
			this.settings.regexArray.forEach((regexSetting) => {
				const regex = new RegExp(regexSetting.pattern);
				const matches = line.match(regex);
				if (matches) {
					if (matches.length < 1) {
						matchedHeadings.push({
							text: matches[0],
							level: regexSetting.level,
							line: index,
						});
					} else {
						matchedHeadings.push({
							text: matches[1],
							level: regexSetting.level,
							line: index,
						});
					}
				}
			});
		});

		const allHeadings = [...mappedHeadings, ...matchedHeadings].sort(
			(a, b) => a.line - b.line
		);
		await this.createClickableHeadings(file, allHeadings);

		return allHeadings;
	}

	async clearExplorerHeight() {
		const leaf = await this.getFileExplorerLeaf();
		(leaf.view as FileExplorerView).tree.infinityScroll.invalidateAll();
	}

	async getFileExplorerFileItems(): Promise<FileExplorerView["fileItems"]> {
		return ((await this.getFileExplorerLeaf()).view as FileExplorerView)
			.fileItems;
	}

	async getFileExplorerLeaf(): Promise<WorkspaceLeaf> {
		return new Promise((resolve, reject) => {
			let foundLeaf: WorkspaceLeaf | null = null;
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (foundLeaf) {
					return;
				}

				const view = leaf.view as FileExplorerView;
				if (!view || !view.fileItems) {
					return;
				}

				foundLeaf = leaf;

				// (window as any).leaf = leaf;

				resolve(foundLeaf);
			});

			if (!foundLeaf) {
				reject(Error("Could not find file explorer leaf."));
			}
		});
	}

	getHeadingContainer(item: Element): Element {
		const existingContainer = item.querySelector(".file-heading-container");
		if (existingContainer) {
			return existingContainer;
		}

		const newContainer = document.createElement("div");
		newContainer.classList.add("file-heading-container");
		item.appendChild(newContainer);
		return newContainer;
	}

	async clearHeadings() {
		const fileExplorerLeafItems = await this.getFileExplorerFileItems();

		for (const key in fileExplorerLeafItems) {
			if (!fileExplorerLeafItems.hasOwnProperty(key)) continue;
			const obj = fileExplorerLeafItems[key];
			const item = obj.innerEl;
			const headingContainer = this.getHeadingContainer(item);
			// clear existing headings
			headingContainer.replaceChildren();
		}
	}

	async clearHeadingsForFolder(folder: TFolder) {
		const fileExplorerLeafItems = await this.getFileExplorerFileItems();

		for (const file of folder.children) {
			if ("children" in file) continue;

			const key = file.path;
			if (!fileExplorerLeafItems.hasOwnProperty(key)) continue;
			const obj = fileExplorerLeafItems[key];
			const item = obj.innerEl;
			const headingContainer = this.getHeadingContainer(item);
			// clear existing headings
			headingContainer.replaceChildren();
		}
	}

	async createClickableHeadings(file: TFile, headings: HeadingEntry[]) {
		if (headings.length === 0) {
			return;
		}

		const fileExplorerLeafItems = await this.getFileExplorerFileItems();
		const fileItem = fileExplorerLeafItems[file.path];
		const item = fileItem.innerEl;

		const headingContainer = this.getHeadingContainer(item);
		// clear existing headings
		headingContainer.replaceChildren();

		headings.forEach((heading) => {
			const headingItem = document.createElement("div");
			headingItem.textContent = heading.text;

			headingItem.classList.add("clickable-heading");

			headingItem.on("click", "*", (e: MouseEvent) => {
				e.preventDefault();
				this.app.workspace
					.openLinkText("", file.path, false, {
						active: true,
						eState: {
							line: heading.line,
						},
					})
					.then(() => {
						setTimeout(() => {
							this.unhighlightSelection(heading.line);
						}, 500);
					});
			});
			headingItem.on("auxclick", "*", (e: MouseEvent) => {
				if (e.button !== 1) return;

				e.preventDefault();
				this.app.workspace
					.openLinkText("", file.path, true, {
						active: true,
						eState: {
							line: heading.line,
						},
					})
					.then(() => {
						setTimeout(() => {
							this.unhighlightSelection(heading.line);
						}, 500);
					});
			});

			const getMarginMultiplier =
				parseInt(
					getComputedStyle(document.body).getPropertyValue(
						"--clickable-heading-margin-multiplier"
					)
				) || 10;
			headingItem.style.marginLeft = `${
				(heading.level - 1) * getMarginMultiplier
			}px`;
			heading.uiElement = headingItem;

			headingContainer.appendChild(headingItem);
		});
	}

	unhighlightSelection(line: number) {
		const activeLeafView = this.lastActiveMarkdownLeaf
			?.view as MarkdownView;
		const position = { line: line, ch: 0 };
		activeLeafView.editor.setCursor(position);
		activeLeafView.editor.focus();
		activeLeafView.editor.setSelection(position, position);
		activeLeafView.editor.removeHighlights();
	}

	registerFolderHeadingContextMenu() {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, abstractFile) => {
				if (this.settings.showHeadingsForAllFolders) return;

				if (abstractFile instanceof TFolder) {
					const showNoteHeadings =
						this.settings.showHeadingFolders.includes(
							abstractFile.path
						);

					menu.addItem((item) =>
						item
							.setTitle(
								showNoteHeadings
									? "Hide headings for notes"
									: "Show headings for notes"
							)
							.setIcon("heading")
							.onClick(() => {
								if (showNoteHeadings) {
									this.settings.showHeadingFolders =
										this.settings.showHeadingFolders.filter(
											(p) => p != abstractFile.path
										);

									this.clearHeadingsForFolder(abstractFile);
								} else {
									this.settings.showHeadingFolders.push(
										abstractFile.path
									);
								}

								this.saveSettings();
							})
					);
				}
			})
		);
	}

	onunload() {
		this.clearHeadings();
	}

	async loadSettings() {
		this.settings = Object.assign({}, USER_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.init();
	}

	async recalculateHeadings() {
		this.cachedHeadings = {};
		await this.clearHeadings();
		await this.init();
	}
}

class HeadingSettingTab extends PluginSettingTab {
	plugin: HeadingPlugin;
	regexArray: RegexSetting[];

	constructor(app: App, plugin: HeadingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.regexArray = this.plugin.settings.regexArray || [];
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName("Show headings")
			.setDesc(
				"Show headings in the file explorer. Toggle off to restore normal headings."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeadings)
					.onChange(async (value) => {
						this.plugin.settings.showHeadings = value;
						await this.plugin.saveSettings();
						this.plugin.recalculateHeadings();
					})
			);

		new Setting(containerEl)
			.setName("Show Headings For All Folders")
			.setDesc(
				"Show headings for notes in all folders. If disabled, you can enable headings for specific folders by right-clicking the folder and selecting the option from the context menu."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeadingsForAllFolders)
					.onChange(async (value) => {
						this.plugin.settings.showHeadingsForAllFolders = value;
						await this.plugin.saveSettings();
						this.plugin.recalculateHeadings();
						this.display(); // Refresh to show/hide folder management section
					})
			);

		// Add folder management section when showHeadingsForAllFolders is disabled
		if (!this.plugin.settings.showHeadingsForAllFolders) {
			new Setting(containerEl)
				.setName("Folder-specific headings")
				.setHeading();

			// Add description
			const descEl = containerEl.createEl("div", {
				cls: "setting-item-description",
				text: "Manage which folders show headings. You can also add or remove folders by right-clicking them in the file browser.",
			});
			descEl.style.marginBottom = "1em";
			descEl.style.fontStyle = "italic";

			const foldersEl = containerEl.createDiv("enabled-folders");

			// Display existing folders
			this.plugin.settings.showHeadingFolders.forEach(
				(folderPath, index) => {
					this.addFolderRow(foldersEl, folderPath, index);
				}
			);

			// Add new folder input row
			this.addNewFolderRow(foldersEl);
		}

		new Setting(containerEl)
			.setName("Control which headings are displayed")
			.setHeading();

		new Setting(containerEl)
			.setName("Show heading 1")
			.setDesc("Show heading 1 in the file explorer.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeading1)
					.onChange(async (value) => {
						this.plugin.settings.showHeading1 = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show heading 2")
			.setDesc("Show heading 2 in the file explorer.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeading2)
					.onChange(async (value) => {
						this.plugin.settings.showHeading2 = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show heading 3")
			.setDesc("Show heading 3 in the file explorer.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeading3)
					.onChange(async (value) => {
						this.plugin.settings.showHeading3 = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show heading 4")
			.setDesc("Show heading 4 in the file explorer.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeading4)
					.onChange(async (value) => {
						this.plugin.settings.showHeading4 = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show heading 5")
			.setDesc("Show heading 5 in the file explorer.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeading5)
					.onChange(async (value) => {
						this.plugin.settings.showHeading5 = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Show heading 6")
			.setDesc("Show heading 6 in the file explorer")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showHeading6)
					.onChange(async (value) => {
						this.plugin.settings.showHeading6 = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom heading patterns")
			.setHeading();
		const regexEl = containerEl.createDiv("regex-patterns");

		new Setting(this.containerEl).addButton((button) => {
			button.setButtonText("Add regex pattern").onClick(() => {
				this.addRegexPatternField(regexEl);
			});
		});

		this.regexArray.forEach((pattern, index) => {
			this.addRegexPatternField(regexEl, pattern, index);
		});

		new Setting(containerEl).setName("Troubleshoot").setHeading();

		new Setting(containerEl)
			.setName("Recalculate headings")
			.setDesc("Recalculates the headings for all files in the vault.")
			.addButton((button) => {
				button
					.setButtonText("Recalculate headings")
					.setWarning()
					.onClick(async () => {
						this.plugin.recalculateHeadings();
						new Notice("Headings recalculated.");
					});
			});

		new Setting(containerEl)
			.setName("Reset to default")
			.setDesc("Reset all settings to default values.")
			.addButton((button) => {
				button
					.setButtonText("Reset to default")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings = structuredClone(
							DEFAULT_SETTINGS
						) as HeadingPluginSettings;
						this.regexArray = this.plugin.settings.regexArray;
						await this.plugin.saveSettings();
						this.display();

						this.plugin.recalculateHeadings();
						new Notice("Settings reset to default.");
					});
			});
	}

	addFolderRow(foldersEl: HTMLElement, folderPath: string, index: number) {
		const setting = new Setting(foldersEl)
			.setName(folderPath || "Empty path")
			.setDesc(`Folder path: ${folderPath}`);

		setting.addButton((button) => {
			button
				.setButtonText("Remove")
				.setTooltip("Remove this folder from the list")
				.onClick(async () => {
					// Find the folder object to clear its headings
					const folder =
						this.app.vault.getAbstractFileByPath(folderPath);
					if (folder instanceof TFolder) {
						await this.plugin.clearHeadingsForFolder(folder);
					}

					this.plugin.settings.showHeadingFolders.splice(index, 1);
					await this.plugin.saveSettings();
					this.display(); // Refresh the settings display
				});
		});
	}

	addNewFolderRow(foldersEl: HTMLElement) {
		let newFolderPath = "";

		const setting = new Setting(foldersEl)
			.setName("Add new folder")
			.setDesc(
				"Enter the folder path to enable headings for that folder"
			);

		setting.addText((text) =>
			text
				.setPlaceholder(
					"Enter folder path (e.g., 'My Folder' or 'Parent/Child')"
				)
				.onChange((value) => {
					newFolderPath = value;
				})
		);

		setting.addButton((button) => {
			button
				.setButtonText("Add")
				.setTooltip("Add this folder to the list")
				.onClick(async () => {
					if (
						newFolderPath.trim() &&
						!this.plugin.settings.showHeadingFolders.includes(
							newFolderPath.trim()
						)
					) {
						this.plugin.settings.showHeadingFolders.push(
							newFolderPath.trim()
						);
						await this.plugin.saveSettings();
						this.display(); // Refresh the settings display
					} else if (
						this.plugin.settings.showHeadingFolders.includes(
							newFolderPath.trim()
						)
					) {
						new Notice("This folder is already in the list.");
					} else {
						new Notice("Please enter a valid folder path.");
					}
				});
		});
	}

	addRegexPatternField(
		regexEl: HTMLElement,
		regexSetting = { pattern: "", level: 1 },
		index = this.regexArray.length
	) {
		const setting = new Setting(regexEl)
			.setName(`Custom pattern`)
			.setDesc(`Enter a regex pattern and specify its level.`);

		setting.addText((text) =>
			text
				.setValue(regexSetting.pattern)
				.setPlaceholder("Enter regex pattern...")
				.onChange(async (value) => {
					this.regexArray[index] = {
						...this.regexArray[index],
						pattern: value,
					};
					await this.plugin.saveSettings();
				})
		);

		setting.addSlider((slider) =>
			slider
				.setLimits(1, 7, 1)
				.setValue(regexSetting.level)
				.setDynamicTooltip()
				.onChange(async (value) => {
					this.regexArray[index] = {
						...this.regexArray[index],
						level: value,
					};
					await this.plugin.saveSettings();
				})
		);

		setting.addButton((button) => {
			button.setButtonText("Delete").onClick(async () => {
				this.regexArray.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});
		});
	}
}
