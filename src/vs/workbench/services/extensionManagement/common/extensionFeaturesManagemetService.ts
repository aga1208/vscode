/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { ExtensionIdentifier } from 'vs/platform/extensions/common/extensions';
import { Disposable } from 'vs/base/common/lifecycle';
import Severity from 'vs/base/common/severity';
import { Extensions, IExtensionFeatureAccessData, IExtensionFeaturesManagementService, IExtensionFeaturesRegistry } from 'vs/workbench/services/extensionManagement/common/extensionFeatures';
import { InstantiationType, registerSingleton } from 'vs/platform/instantiation/common/extensions';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { Registry } from 'vs/platform/registry/common/platform';
import { IStringDictionary } from 'vs/base/common/collections';
import { Mutable } from 'vs/base/common/types';
import { IDialogService } from 'vs/platform/dialogs/common/dialogs';
import { localize } from 'vs/nls';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';
import { IStorageChangeEvent } from 'vs/base/parts/storage/common/storage';
import { distinct } from 'vs/base/common/arrays';
import { equals } from 'vs/base/common/objects';

interface IExtensionFeatureState {
	disabled?: boolean;
	accessData: Mutable<IExtensionFeatureAccessData>;
}

const FEATURES_STATE_KEY = 'extension.features.state';

class ExtensionFeaturesManagementService extends Disposable implements IExtensionFeaturesManagementService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeEnablement = this._register(new Emitter<{ extension: ExtensionIdentifier; featureId: string; enabled: boolean }>());
	readonly onDidChangeEnablement = this._onDidChangeEnablement.event;

	private readonly _onDidChangeAccessData = this._register(new Emitter<{ extension: ExtensionIdentifier; featureId: string; accessData: IExtensionFeatureAccessData }>());
	readonly onDidChangeAccessData = this._onDidChangeAccessData.event;

	private readonly registry: IExtensionFeaturesRegistry;
	private extensionFeaturesState = new Map<string, Map<string, IExtensionFeatureState>>();

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IDialogService private readonly dialogService: IDialogService,
		@IExtensionService private readonly extensionService: IExtensionService,
	) {
		super();
		this.registry = Registry.as<IExtensionFeaturesRegistry>(Extensions.ExtensionFeaturesRegistry);
		this.extensionFeaturesState = this.loadState();
		this._register(storageService.onDidChangeValue(StorageScope.PROFILE, FEATURES_STATE_KEY, this._store)(e => this.onDidStorageChange(e)));
	}

	isEnabled(extension: ExtensionIdentifier, featureId: string): boolean {
		const feature = this.registry.getExtensionFeature(featureId);
		if (!feature) {
			return false;
		}
		return !(this.getExtensionFeatureState(extension, featureId)?.disabled ?? false);
	}

	setEnablement(extension: ExtensionIdentifier, featureId: string, enabled: boolean): void {
		const feature = this.registry.getExtensionFeature(featureId);
		if (!feature) {
			throw new Error(`No feature with id '${featureId}'`);
		}
		const featureState = this.getAndSetIfNotExistsExtensionFeatureState(extension, featureId);
		if (featureState.disabled !== !enabled) {
			featureState.disabled = !enabled;
			this._onDidChangeEnablement.fire({ extension, featureId, enabled });
			this.saveState();
		}
	}

	getEnablementData(featureId: string): { readonly extension: ExtensionIdentifier; readonly enabled: boolean }[] {
		const result: { readonly extension: ExtensionIdentifier; readonly enabled: boolean }[] = [];
		const feature = this.registry.getExtensionFeature(featureId);
		if (feature) {
			for (const [extension, featuresStateMap] of this.extensionFeaturesState) {
				const featureState = featuresStateMap.get(featureId);
				if (featureState?.disabled !== undefined) {
					result.push({ extension: new ExtensionIdentifier(extension), enabled: !featureState.disabled });
				}
			}
		}
		return result;
	}

	async getAccess(extension: ExtensionIdentifier, featureId: string): Promise<boolean> {
		const feature = this.registry.getExtensionFeature(featureId);
		if (!feature) {
			return false;
		}
		const featureState = this.getAndSetIfNotExistsExtensionFeatureState(extension, featureId);
		if (featureState.disabled) {
			return false;
		}

		if (featureState.disabled === undefined) {
			const extensionDescription = this.extensionService.extensions.find(e => ExtensionIdentifier.equals(e.identifier, extension));
			const confirmationResult = await this.dialogService.confirm({
				title: localize('accessExtensionFeature', "Access '{0}' Feature", feature.label),
				message: localize('accessExtensionFeatureMessage', "'{0}' extension would like to access the '{1}' feature.", extensionDescription?.displayName ?? extension.value, feature.label),
				detail: feature.description,
				custom: true,
				primaryButton: localize('allow', "Allow"),
				cancelButton: localize('disallow', "Don't Allow"),
			});
			this.setEnablement(extension, featureId, confirmationResult.confirmed);
			if (!confirmationResult.confirmed) {
				return false;
			}
		}

		featureState.accessData.current = {
			count: featureState.accessData.current?.count ? featureState.accessData.current?.count + 1 : 1,
			lastAccessed: Date.now(),
			status: featureState.accessData.current?.status
		};
		featureState.accessData.totalCount = featureState.accessData.totalCount + 1;
		this.saveState();
		this._onDidChangeAccessData.fire({ extension, featureId, accessData: featureState.accessData });
		return true;
	}

	getAccessData(extension: ExtensionIdentifier, featureId: string): IExtensionFeatureAccessData | undefined {
		const feature = this.registry.getExtensionFeature(featureId);
		if (!feature) {
			return;
		}
		return this.getExtensionFeatureState(extension, featureId)?.accessData;
	}

	setStatus(extension: ExtensionIdentifier, featureId: string, status: { readonly severity: Severity; readonly message: string } | undefined): void {
		const feature = this.registry.getExtensionFeature(featureId);
		if (!feature) {
			throw new Error(`No feature with id '${featureId}'`);
		}
		const featureState = this.getAndSetIfNotExistsExtensionFeatureState(extension, featureId);
		featureState.accessData.current = {
			count: featureState.accessData.current?.count ?? 0,
			lastAccessed: featureState.accessData.current?.lastAccessed ?? 0,
			status
		};
		this._onDidChangeAccessData.fire({ extension, featureId, accessData: this.getAccessData(extension, featureId)! });
	}

	private getExtensionFeatureState(extension: ExtensionIdentifier, featureId: string): IExtensionFeatureState | undefined {
		return this.extensionFeaturesState.get(extension.value)?.get(featureId);
	}

	private getAndSetIfNotExistsExtensionFeatureState(extension: ExtensionIdentifier, featureId: string): Mutable<IExtensionFeatureState> {
		let extensionState = this.extensionFeaturesState.get(extension.value);
		if (!extensionState) {
			extensionState = new Map<string, IExtensionFeatureState>();
			this.extensionFeaturesState.set(extension.value, extensionState);
		}
		let featureState = extensionState.get(featureId);
		if (!featureState) {
			featureState = { accessData: { totalCount: 0 } };
			extensionState.set(featureId, featureState);
		}
		return featureState;
	}

	private onDidStorageChange(e: IStorageChangeEvent): void {
		if (e.external) {
			const oldState = this.extensionFeaturesState;
			this.extensionFeaturesState = this.loadState();
			for (const extensionId of distinct([...oldState.keys(), ...this.extensionFeaturesState.keys()])) {
				const extension = new ExtensionIdentifier(extensionId);
				const oldExtensionFeaturesState = oldState.get(extensionId);
				const newExtensionFeaturesState = this.extensionFeaturesState.get(extensionId);
				for (const featureId of distinct([...oldExtensionFeaturesState?.keys() ?? [], ...newExtensionFeaturesState?.keys() ?? []])) {
					const isEnabled = this.isEnabled(extension, featureId);
					const wasEnabled = !oldExtensionFeaturesState?.get(featureId)?.disabled;
					if (isEnabled !== wasEnabled) {
						this._onDidChangeEnablement.fire({ extension, featureId, enabled: isEnabled });
					}
					const newAccessData = this.getAccessData(extension, featureId);
					const oldAccessData = oldExtensionFeaturesState?.get(featureId)?.accessData;
					if (!equals(newAccessData, oldAccessData)) {
						this._onDidChangeAccessData.fire({ extension, featureId, accessData: newAccessData ?? { totalCount: 0 } });
					}
				}
			}
		}
	}

	private loadState(): Map<string, Map<string, IExtensionFeatureState>> {
		let data: IStringDictionary<IStringDictionary<{ disabled?: boolean; accessCount: number }>> = {};
		const raw = this.storageService.get(FEATURES_STATE_KEY, StorageScope.PROFILE, '{}');
		try {
			data = JSON.parse(raw);
		} catch (e) {
			// ignore
		}
		const result = new Map<string, Map<string, IExtensionFeatureState>>();
		for (const extensionId in data) {
			const extensionFeatureState = new Map<string, IExtensionFeatureState>();
			const extensionFeatures = data[extensionId];
			for (const featureId in extensionFeatures) {
				const extensionFeature = extensionFeatures[featureId];
				extensionFeatureState.set(featureId, {
					disabled: extensionFeature.disabled,
					accessData: {
						totalCount: extensionFeature.accessCount
					}
				});
			}
			result.set(extensionId, extensionFeatureState);
		}
		return result;
	}

	private saveState(): void {
		const data: IStringDictionary<IStringDictionary<{ disabled?: boolean; accessCount: number }>> = {};
		this.extensionFeaturesState.forEach((extensionState, extensionId) => {
			const extensionFeatures: IStringDictionary<{ disabled?: boolean; accessCount: number }> = {};
			extensionState.forEach((featureState, featureId) => {
				extensionFeatures[featureId] = {
					disabled: featureState.disabled,
					accessCount: featureState.accessData.totalCount
				};
			});
			data[extensionId] = extensionFeatures;
		});
		this.storageService.store(FEATURES_STATE_KEY, JSON.stringify(data), StorageScope.PROFILE, StorageTarget.USER);
	}
}

registerSingleton(IExtensionFeaturesManagementService, ExtensionFeaturesManagementService, InstantiationType.Delayed);
