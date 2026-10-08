import { Container } from 'typedi';
import { presentOrgReviewDetail } from '../../presenters/organization.presenter';
import {
  OrganizationAdminService,
  OrganizationDocumentService,
  OrganizationService,
} from '../../../services/organization';
import { ProviderCoverageService } from '../../../services/provider';
import { LocationService } from '../../../services/location';
import type { Language } from '../../../utils/i18n';

/** The organization's full submission for admins (verification queue and /admin/organizations/{id}). */
export const buildOrgReviewDetail = async (id: string, lang: Language) => {
  const { org, owner, checklist } = await Container.get(OrganizationAdminService).getForReview(id);
  const organizations = Container.get(OrganizationService);
  const [logoUrl, documents, places, teamSizes, catalog] = await Promise.all([
    organizations.logoUrl(org),
    Container.get(OrganizationDocumentService).list(org._id),
    Container.get(LocationService).describeAreas(org.serviceAreas.map((a) => String(a.areaId))),
    organizations.teamSizes(org),
    Container.get(ProviderCoverageService).describeServices(org),
  ]);
  return presentOrgReviewDetail({
    org,
    owner,
    logoUrl,
    checklist,
    documents,
    places,
    teamSizes,
    catalog,
    lang,
  });
};
