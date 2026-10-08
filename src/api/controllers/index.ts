import type IBaseController from './interfaces/base-controller.interface';
import HealthController from './health/health.controller';
import AuthController from './auth/auth.controller';
import MeController from './me/me.controller';
import AppConfigController from './app-config/app-config.controller';
import LocationController from './location/location.controller';
import AdminLocationController from './location/admin-location.controller';
import CatalogController from './catalog/catalog.controller';
import AdminCatalogController from './catalog/admin-catalog.controller';
import UploadController from './upload/upload.controller';
import AddressController from './address/address.controller';
import PatientProfileController from './patient/patient-profile.controller';
import ProviderController from './provider/provider.controller';
import AdminVerificationController from './provider/admin-verification.controller';
import DiscoveryController from './discovery/discovery.controller';
import BookingController from './booking/booking.controller';
import ProviderBookingController from './booking/provider-booking.controller';
import NotificationController from './notification/notification.controller';
import AdminSystemController from './admin/admin-system.controller';
import AdminUserController from './admin/admin-user.controller';
import AdminBookingController from './admin/admin-booking.controller';
import ChatController from './chat/chat.controller';
import PaymentController from './payment/payment.controller';
import FinanceController from './finance/finance.controller';
import MarketingController from './marketing/marketing.controller';
import AdminMarketingController from './admin/admin-marketing.controller';
import OrganizationController from './organization/organization.controller';
import AdminOrganizationController from './admin/admin-organization.controller';
import OrgStaffController from './organization/org-staff.controller';

/**
 * Register every controller here. Each one is instantiated once at boot
 * and mounted under the API prefix by Server.initRoutes().
 */
const controllerClasses: Array<new () => IBaseController> = [
  HealthController,
  AuthController,
  MeController,
  AppConfigController,
  LocationController,
  CatalogController,
  AdminLocationController,
  AdminCatalogController,
  UploadController,
  AddressController,
  PatientProfileController,
  ProviderController,
  AdminVerificationController,
  DiscoveryController,
  BookingController,
  ProviderBookingController,
  NotificationController,
  AdminSystemController,
  AdminUserController,
  AdminBookingController,
  ChatController,
  PaymentController,
  FinanceController,
  MarketingController,
  AdminMarketingController,
  OrganizationController,
  AdminOrganizationController,
  OrgStaffController,
];

export const getGlobalControllers = (): IBaseController[] => controllerClasses.map((C) => new C());
