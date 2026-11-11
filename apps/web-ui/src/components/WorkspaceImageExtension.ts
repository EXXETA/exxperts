import { mergeAttributes } from "@tiptap/core";
import { Image } from "@tiptap/extension-image";
import { Link } from "@tiptap/extension-link";
import { Paragraph } from "@tiptap/extension-paragraph";

// The stock parser lifts an image alone in a paragraph out of it, for block images.
// Ours are inline, so that would leave inline content directly in the document, which the editor refuses.
export const WorkspaceParagraph = Paragraph.extend({
	parseMarkdown(token, helpers) {
		const tokens = token.tokens ?? [];
		if (tokens.length === 1 && tokens[0].type === "image") return helpers.createNode("paragraph", undefined, helpers.parseInline(tokens));
		return Paragraph.config.parseMarkdown!.call(this, token, helpers);
	},
	renderMarkdown(node, helpers, context) {
		const content = node.content ?? [];
		if (!content.some((child) => child.type === "image" && child.attrs?.linkHref)) return Paragraph.config.renderMarkdown!.call(this, node, helpers, context);
		let output = "";
		for (let i = 0; i < content.length;) {
			const child = content[i];
			const link = child.type === "image" && child.attrs?.linkHref ? { href: child.attrs.linkHref, title: child.attrs.linkTitle } : child.marks?.find((mark) => mark.type === "link")?.attrs;
			if (!link?.href) { output += helpers.renderChildren([child]); i++; continue; }
			const group = [];
			while (i < content.length) {
				const item = content[i];
				const itemLink = item.type === "image" && item.attrs?.linkHref ? { href: item.attrs.linkHref, title: item.attrs.linkTitle } : item.marks?.find((mark) => mark.type === "link")?.attrs;
				if (itemLink?.href !== link.href || (itemLink?.title ?? null) !== (link.title ?? null)) break;
				group.push({ ...item, marks: item.marks?.filter((mark) => mark.type !== "link"), attrs: item.type === "image" ? { ...item.attrs, linkHref: null, linkTitle: null } : item.attrs });
				i++;
			}
			output += `[${helpers.renderChildren(group)}](${link.href}${markdownTitle(link.title)})`;
		}
		return output;
	},
});

// Marks only apply to text, so a linked image would lose its link on save. It keeps the link on itself instead.
export const WorkspaceLink = Link.extend({
	parseMarkdown(token, helpers) {
		const tokens = token.tokens ?? [];
		if (tokens.some((part) => part.type === "image")) {
			return helpers.parseInline(tokens).map((node) => node.type === "image"
				? { ...node, attrs: { ...node.attrs, linkHref: token.href, linkTitle: token.title || null } }
				: { ...node, marks: [...(node.marks ?? []), { type: "link", attrs: { href: token.href, title: token.title || null } }] });
		}
		return Link.config.parseMarkdown!.call(this, token, helpers);
	},
});

function markdownTitle(title: unknown): string {
	return title ? ` "${String(title).replaceAll('"', '\\"')}"` : "";
}

// The node keeps the source from the Markdown, so saving writes it back unchanged;
// only the rendered <img> points at where the browser can load it.
export function createWorkspaceImageExtension(resolveSrcRef: { current: (src: string) => string | null }) {
	return Image.extend({
		addAttributes() {
			return {
				...this.parent?.(),
				linkHref: { default: null, rendered: false },
				linkTitle: { default: null, rendered: false },
			};
		},
		renderHTML({ HTMLAttributes }) {
			const src = resolveSrcRef.current(String(HTMLAttributes.src ?? "")) ?? "";
			return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { src })];
		},
		// The stock serialiser drops the <…> a source with spaces needs, which breaks the image on the next load.
		renderMarkdown(node) {
			const src = String(node.attrs?.src ?? "");
			const destination = /\s/.test(src) ? `<${src}>` : src;
			const image = `![${String(node.attrs?.alt ?? "")}](${destination}${markdownTitle(node.attrs?.title)})`;
			return node.attrs?.linkHref ? `[${image}](${node.attrs.linkHref}${markdownTitle(node.attrs.linkTitle)})` : image;
		},
	}).configure({ inline: true });
}
