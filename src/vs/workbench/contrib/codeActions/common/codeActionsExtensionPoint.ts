/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as nls from 'vs/nls';
import { IConfigurationPropertySchema } from 'vs/platform/configuration/common/configurationRegistry';
import { languagesExtPoint } from 'vs/workbench/services/language/common/languageService';
import { Extensions as ExtensionFeaturesExtensions, IExtensionFeatureTableRenderer, IExtensionFeaturesRegistry, IRenderedData, IRowData, ITableData } from 'vs/workbench/services/extensionManagement/common/extensionFeatures';
import { Disposable } from 'vs/base/common/lifecycle';
import { SyncDescriptor } from 'vs/platform/instantiation/common/descriptors';
import { IExtensionManifest } from 'vs/platform/extensions/common/extensions';
import { Registry } from 'vs/platform/registry/common/platform';

enum CodeActionExtensionPointFields {
	languages = 'languages',
	actions = 'actions',
	kind = 'kind',
	title = 'title',
	description = 'description'
}

export interface ContributedCodeAction {
	readonly [CodeActionExtensionPointFields.kind]: string;
	readonly [CodeActionExtensionPointFields.title]: string;
	readonly [CodeActionExtensionPointFields.description]?: string;
}

export interface CodeActionsExtensionPoint {
	readonly [CodeActionExtensionPointFields.languages]: readonly string[];
	readonly [CodeActionExtensionPointFields.actions]: readonly ContributedCodeAction[];
}

const codeActionsExtensionPointSchema = Object.freeze<IConfigurationPropertySchema>({
	type: 'array',
	markdownDescription: nls.localize('contributes.codeActions', "Configure which editor to use for a resource."),
	items: {
		type: 'object',
		required: [CodeActionExtensionPointFields.languages, CodeActionExtensionPointFields.actions],
		properties: {
			[CodeActionExtensionPointFields.languages]: {
				type: 'array',
				description: nls.localize('contributes.codeActions.languages', "Language modes that the code actions are enabled for."),
				items: { type: 'string' }
			},
			[CodeActionExtensionPointFields.actions]: {
				type: 'object',
				required: [CodeActionExtensionPointFields.kind, CodeActionExtensionPointFields.title],
				properties: {
					[CodeActionExtensionPointFields.kind]: {
						type: 'string',
						markdownDescription: nls.localize('contributes.codeActions.kind', "`CodeActionKind` of the contributed code action."),
					},
					[CodeActionExtensionPointFields.title]: {
						type: 'string',
						description: nls.localize('contributes.codeActions.title', "Label for the code action used in the UI."),
					},
					[CodeActionExtensionPointFields.description]: {
						type: 'string',
						description: nls.localize('contributes.codeActions.description', "Description of what the code action does."),
					},
				}
			}
		}
	}
});

export const codeActionsExtensionPointDescriptor = {
	extensionPoint: 'codeActions',
	deps: [languagesExtPoint],
	jsonSchema: codeActionsExtensionPointSchema
};

class CodeActionsTableRenderer extends Disposable implements IExtensionFeatureTableRenderer {

	readonly type = 'table';

	shouldRender(manifest: IExtensionManifest): boolean {
		return !!manifest.contributes?.codeActions;
	}

	render(manifest: IExtensionManifest): IRenderedData<ITableData> {
		const codeActions = manifest.contributes?.codeActions || [];
		if (!codeActions.length) {
			return { data: { headers: [], rows: [] }, dispose: () => { } };
		}

		const flatActions =
			codeActions.map(contribution =>
				contribution.actions.map(action => ({ ...action, languages: contribution.languages }))).flat();

		const headers = [
			nls.localize('codeActions.title', "Title"),
			nls.localize('codeActions.kind', "Kind"),
			nls.localize('codeActions.description', "Description"),
			nls.localize('codeActions.languages', "Languages")
		];

		const rows: IRowData[][] = flatActions.sort((a, b) => a.title.localeCompare(b.title))
			.map(action => {
				return [
					action.title,
					{ data: action.kind, type: 'code' },
					action.description ?? '',
					{ data: [...action.languages], type: 'code' },
				];
			});

		return {
			data: {
				headers,
				rows
			},
			dispose: () => { }
		};
	}
}

Registry.as<IExtensionFeaturesRegistry>(ExtensionFeaturesExtensions.ExtensionFeaturesRegistry).registerExtensionFeature({
	id: 'codeActions',
	label: nls.localize('codeactions', "Code Actions"),
	enablement: {
		canToggle: false,
	},
	renderer: new SyncDescriptor(CodeActionsTableRenderer),
});
